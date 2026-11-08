import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { codexCliCredentials, CodexLoginError } from "../src/providers/openai-codex/cli-login.js"

const NOW = Date.parse("2026-11-08T00:00:00Z")

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`

const withHome = async (auth: string | undefined, run: (home: string) => Promise<void>) => {
  const home = await mkdtemp(join(tmpdir(), "codex-home-"))
  try {
    if (auth !== undefined) await writeFile(join(home, "auth.json"), auth)
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const read = (home: string) =>
  codexCliCredentials({ env: { CODEX_HOME: home }, now: () => NOW }).get({
    signal: new AbortController().signal
  })

it("reads the token and sends the account id as a header", () =>
  withHome(
    JSON.stringify({
      tokens: { access_token: jwt({ exp: NOW / 1000 + 3600 }), account_id: "acct-1" }
    }),
    async (home) => {
      const credential = await read(home)
      expect(credential.accessToken).toBe(jwt({ exp: NOW / 1000 + 3600 }))
      expect(credential.headers).toEqual({ "chatgpt-account-id": "acct-1" })
    }
  ))

it("omits the header without an account id", () =>
  withHome(JSON.stringify({ tokens: { access_token: jwt({}) } }), async (home) => {
    expect((await read(home)).headers).toBeUndefined()
  }))

it("rejects a file without tokens", () =>
  withHome(JSON.stringify({ OPENAI_API_KEY: "x" }), async (home) => {
    await expect(read(home)).rejects.toBeInstanceOf(CodexLoginError)
  }))

it("rejects a missing file", () =>
  withHome(undefined, async (home) => {
    await expect(read(home)).rejects.toBeInstanceOf(CodexLoginError)
  }))

it("rejects an expired token", () =>
  withHome(
    JSON.stringify({ tokens: { access_token: jwt({ exp: NOW / 1000 - 1 }) } }),
    async (home) => {
      await expect(read(home)).rejects.toThrow("expired")
    }
  ))

it("reads the file again on every get", () =>
  withHome(
    JSON.stringify({ tokens: { access_token: jwt({ exp: NOW / 1000 + 60 }) } }),
    async (home) => {
      const first = await read(home)
      await writeFile(
        join(home, "auth.json"),
        JSON.stringify({ tokens: { access_token: jwt({ exp: NOW / 1000 + 120 }) } })
      )
      expect((await read(home)).accessToken).not.toBe(first.accessToken)
    }
  ))
