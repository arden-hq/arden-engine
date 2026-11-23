import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  CHATGPT_LOGIN_FILE,
  ChatGptLoginError,
  chatGptCredentials,
  chatGptLoginFile,
  startChatGptLogin,
  type ChatGptTokens
} from "../src/chatgpt-login.js"

const NOW = 1_800_000_000_000

const jwt = (claims: Record<string, unknown>): string =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

interface TokenRequest {
  readonly contentType: string | undefined
  readonly body: string
}

let issuer = ""
let server: Server | undefined
let folder = ""
let requests: Array<TokenRequest> = []
let reply: { status: number; body: unknown } = { status: 200, body: {} }
let beforeReply: () => Promise<void> = async () => undefined

beforeEach(async () => {
  requests = []
  beforeReply = async () => undefined
  folder = await mkdtemp(join(tmpdir(), "arden-chatgpt-login-"))
  const listening = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8")
    })
    request.on("end", () => {
      if (request.url !== "/oauth/token") {
        response.writeHead(404).end()
        return
      }
      requests.push({ contentType: request.headers["content-type"], body })
      void beforeReply().then(() => {
        response.writeHead(reply.status, { "Content-Type": "application/json" })
        response.end(JSON.stringify(reply.body))
      })
    })
  })
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve))
  const address = listening.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  issuer = `http://127.0.0.1:${address.port}`
  server = listening
})

afterEach(async () => {
  server?.close()
  await rm(folder, { recursive: true, force: true })
})

describe("startChatGptLogin", () => {
  it("signs in through the browser callback with PKCE and reads the account id", async () => {
    reply = {
      status: 200,
      body: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3_600,
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })
      }
    }
    const login = await startChatGptLogin({ issuer, port: 0, now: () => NOW })
    const authorize = new URL(login.url)
    const redirect = authorize.searchParams.get("redirect_uri") ?? ""
    expect(authorize.origin + authorize.pathname).toBe(`${issuer}/oauth/authorize`)
    expect(redirect).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/)
    const callback = new URL(redirect)
    callback.searchParams.set("code", "code-1")
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "")
    expect((await fetch(callback)).status).toBe(200)
    expect(await login.tokens).toEqual({
      access: "access-1",
      refresh: "refresh-1",
      expires: NOW + 3_600_000,
      accountId: "account-1"
    })
    const [request] = requests
    const form = new URLSearchParams(request?.body)
    expect(request?.contentType).toBe("application/x-www-form-urlencoded")
    expect(form.get("grant_type")).toBe("authorization_code")
    expect(form.get("code")).toBe("code-1")
    expect(form.get("redirect_uri")).toBe(redirect)
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    expect(
      createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url")
    ).toBe(authorize.searchParams.get("code_challenge"))
  })

  it("turns away a callback with another state and keeps waiting for its own", async () => {
    reply = { status: 200, body: { access_token: "access-1", refresh_token: "refresh-1" } }
    const login = await startChatGptLogin({ issuer, port: 0, now: () => NOW })
    const authorize = new URL(login.url)
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "")
    callback.searchParams.set("code", "code-1")
    callback.searchParams.set("state", "forged")
    expect((await fetch(callback)).status).toBe(400)
    expect(requests).toEqual([])
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "")
    expect((await fetch(callback)).status).toBe(200)
    expect(await login.tokens).toEqual({
      access: "access-1",
      refresh: "refresh-1",
      expires: NOW + 3_600_000,
      accountId: undefined
    })
  })
})

describe("chatGptCredentials", () => {
  const expired: ChatGptTokens = {
    access: "old-access",
    refresh: "old-refresh",
    expires: NOW - 1,
    accountId: "account-1"
  }

  it("refreshes an expired login, keeps the refresh token, and saves it 0600", async () => {
    const store = chatGptLoginFile(folder)
    await store.write(expired)
    reply = { status: 200, body: { access_token: "new-access", expires_in: 3_600 } }
    const credentials = chatGptCredentials({ store, issuer, now: () => NOW })
    expect(await credentials.get()).toEqual({ accessToken: "new-access", accountId: "account-1" })
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
      client_id: expect.any(String)
    })
    expect(await store.read()).toEqual({
      access: "new-access",
      refresh: "old-refresh",
      expires: NOW + 3_600_000,
      accountId: "account-1"
    })
    expect((await stat(join(folder, CHATGPT_LOGIN_FILE))).mode & 0o777).toBe(0o600)
    expect(await credentials.get()).toEqual({ accessToken: "new-access", accountId: "account-1" })
    expect(requests).toHaveLength(1)
  })

  it("forgets a login whose refresh token the issuer rejects", async () => {
    const store = chatGptLoginFile(folder)
    await store.write(expired)
    reply = { status: 400, body: { error: { code: "refresh_token_reused" } } }
    const credentials = chatGptCredentials({ store, issuer, now: () => NOW })
    await expect(credentials.get()).rejects.toEqual(new ChatGptLoginError("refresh_rejected"))
    expect(await store.read()).toBeUndefined()
  })

  it("uses the login another process refreshed when its own refresh token was spent", async () => {
    const store = chatGptLoginFile(folder)
    await store.write(expired)
    const other: ChatGptTokens = {
      access: "other-access",
      refresh: "other-refresh",
      expires: NOW + 3_600_000,
      accountId: "account-1"
    }
    beforeReply = () => store.write(other)
    reply = { status: 400, body: { error: { code: "refresh_token_reused" } } }
    const credentials = chatGptCredentials({ store, issuer, now: () => NOW })
    expect(await credentials.get()).toEqual({ accessToken: "other-access", accountId: "account-1" })
    expect(await store.read()).toEqual(other)
  })

  it("keeps a login through a refresh that fails for another reason", async () => {
    const store = chatGptLoginFile(folder)
    await store.write(expired)
    reply = { status: 500, body: {} }
    const credentials = chatGptCredentials({ store, issuer, now: () => NOW })
    await expect(credentials.get()).rejects.toEqual(new ChatGptLoginError("token_exchange"))
    expect(await store.read()).toEqual(expired)
  })

  it("has no credential without a login, and refuses an unreadable file", async () => {
    const store = chatGptLoginFile(folder)
    expect(await chatGptCredentials({ store, issuer }).get()).toBeUndefined()
    await writeFile(join(folder, CHATGPT_LOGIN_FILE), "{")
    await expect(store.read()).rejects.toEqual(new ChatGptLoginError("unreadable_store"))
    expect(await readFile(join(folder, CHATGPT_LOGIN_FILE), "utf8")).toBe("{")
    await rm(join(folder, CHATGPT_LOGIN_FILE))
    await mkdir(join(folder, CHATGPT_LOGIN_FILE))
    await expect(store.read()).rejects.toEqual(new ChatGptLoginError("unreadable_store"))
  })
})
