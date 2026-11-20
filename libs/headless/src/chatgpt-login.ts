import { writeAtomic } from "@arden-hq/std/atomic-file"
import { isRecord } from "@arden-hq/std/json"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { dirname, join } from "node:path"

export const CHATGPT_ISSUER = "https://auth.openai.com"
export const CHATGPT_CALLBACK_PORT = 1455
export const CHATGPT_LOGIN_FILE = "chatgpt-login.json"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const CALLBACK_PATH = "/auth/callback"
const LOGIN_TIMEOUT_MS = 5 * 60_000
const TOKEN_TIMEOUT_MS = 30_000
const REFRESH_MARGIN_MS = 5 * 60_000
const PERMANENT_REFRESH_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated"
])

export interface ChatGptTokens {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId: string | undefined
}

export interface ChatGptCredential {
  readonly accessToken: string
  readonly accountId: string | undefined
}

export interface ChatGptLoginStore {
  readonly read: () => Promise<ChatGptTokens | undefined>
  readonly write: (tokens: ChatGptTokens) => Promise<void>
  readonly remove: () => Promise<void>
}

export type ChatGptLoginFailure =
  | "callback_port"
  | "state_mismatch"
  | "denied"
  | "token_exchange"
  | "refresh_rejected"
  | "timeout"
  | "cancelled"
  | "unreadable_store"

const FAILURE_MESSAGES: Record<ChatGptLoginFailure, string> = {
  callback_port: `Sign-in could not start: port ${CHATGPT_CALLBACK_PORT} is in use.`,
  state_mismatch: "Sign-in verification failed. Try again.",
  denied: "The ChatGPT sign-in was cancelled in the browser.",
  token_exchange: "The ChatGPT sign-in did not complete. Try again.",
  refresh_rejected: "The ChatGPT sign-in has expired. Sign in again.",
  timeout: "The sign-in expired. Try again.",
  cancelled: "The sign-in was cancelled.",
  unreadable_store: "The saved ChatGPT sign-in is unreadable. Sign in again."
}

export class ChatGptLoginError extends Error {
  override readonly name = "ChatGptLoginError"
  constructor(readonly reason: ChatGptLoginFailure) {
    super(FAILURE_MESSAGES[reason])
  }
}

export interface ChatGptEndpoint {
  readonly issuer?: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

export interface PendingChatGptLogin {
  readonly url: string
  readonly tokens: Promise<ChatGptTokens>
  readonly cancel: () => void
}

export const startChatGptLogin = async ({
  issuer = CHATGPT_ISSUER,
  fetch: fetchImpl = fetch,
  now = Date.now,
  port = CHATGPT_CALLBACK_PORT,
  timeoutMs = LOGIN_TIMEOUT_MS
}: ChatGptEndpoint & {
  readonly port?: number
  readonly timeoutMs?: number
} = {}): Promise<PendingChatGptLogin> => {
  const verifier = randomBytes(64).toString("base64url")
  const state = randomBytes(32).toString("base64url")
  let settle: (outcome: { ok: true; tokens: ChatGptTokens } | { ok: false; error: Error }) => void =
    () => undefined
  const settled = new Promise<{ ok: true; tokens: ChatGptTokens } | { ok: false; error: Error }>(
    (resolve) => {
      settle = resolve
    }
  )
  let redirectUri = ""
  let completing = false
  const server = createServer((request, response) => {
    void answer(request, response)
  })
  const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const callback = new URL(request.url ?? "/", redirectUri)
    if (request.method !== "GET" || callback.pathname !== CALLBACK_PATH || completing) {
      response.writeHead(404).end()
      return
    }
    completing = true
    try {
      const tokens = await tokensFromCallback(callback.searchParams)
      respond(response, true)
      settle({ ok: true, tokens })
    } catch (cause) {
      respond(response, false)
      settle({ ok: false, error: toLoginError(cause) })
    }
  }
  const tokensFromCallback = async (params: URLSearchParams): Promise<ChatGptTokens> => {
    if (params.get("state") !== state) throw new ChatGptLoginError("state_mismatch")
    if (params.get("error") !== null) throw new ChatGptLoginError("denied")
    const code = params.get("code")
    if (code === null || code === "") throw new ChatGptLoginError("state_mismatch")
    return exchangeChatGptCode({ code, redirectUri, verifier, issuer, fetch: fetchImpl, now })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
  } catch {
    server.close()
    throw new ChatGptLoginError("callback_port")
  }
  const address = server.address()
  redirectUri = `http://localhost:${typeof address === "object" && address !== null ? address.port : port}${CALLBACK_PATH}`
  const timer = setTimeout(
    () => settle({ ok: false, error: new ChatGptLoginError("timeout") }),
    timeoutMs
  )
  const tokens = settled.then((outcome) => {
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
    if (!outcome.ok) throw outcome.error
    return outcome.tokens
  })
  return {
    url: chatGptAuthorizeUrl({ issuer, redirectUri, verifier, state }),
    tokens,
    cancel: () => settle({ ok: false, error: new ChatGptLoginError("cancelled") })
  }
}

export const chatGptAuthorizeUrl = ({
  issuer,
  redirectUri,
  verifier,
  state
}: {
  readonly issuer: string
  readonly redirectUri: string
  readonly verifier: string
  readonly state: string
}): string => {
  const url = new URL("/oauth/authorize", issuer)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "arden"
  }).toString()
  return url.href
}

export const exchangeChatGptCode = async ({
  code,
  redirectUri,
  verifier,
  issuer = CHATGPT_ISSUER,
  fetch: fetchImpl = fetch,
  now = Date.now
}: ChatGptEndpoint & {
  readonly code: string
  readonly redirectUri: string
  readonly verifier: string
}): Promise<ChatGptTokens> => {
  const response = await postToken(
    fetchImpl,
    issuer,
    "application/x-www-form-urlencoded",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier
    })
  )
  if (!response.ok) throw new ChatGptLoginError("token_exchange")
  return tokensFromResponse(await bodyOf(response), now(), undefined)
}

export const refreshChatGptTokens = async ({
  tokens,
  issuer = CHATGPT_ISSUER,
  fetch: fetchImpl = fetch,
  now = Date.now
}: ChatGptEndpoint & { readonly tokens: ChatGptTokens }): Promise<ChatGptTokens> => {
  const response = await postToken(
    fetchImpl,
    issuer,
    "application/json",
    JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh,
      client_id: CLIENT_ID
    })
  )
  const body = await bodyOf(response).catch(() => undefined)
  if (!response.ok) {
    throw new ChatGptLoginError(
      response.status === 401 || hasPermanentRefreshCode(body, 0)
        ? "refresh_rejected"
        : "token_exchange"
    )
  }
  const next = tokensFromResponse(body, now(), tokens)
  if (
    tokens.accountId !== undefined &&
    next.accountId !== undefined &&
    next.accountId !== tokens.accountId
  ) {
    throw new ChatGptLoginError("refresh_rejected")
  }
  return next
}

export const chatGptCredentials = ({
  store,
  ...endpoint
}: ChatGptEndpoint & { readonly store: ChatGptLoginStore }): {
  readonly get: (request?: { readonly forceRefresh?: boolean }) => Promise<
    ChatGptCredential | undefined
  >
} => {
  const now = endpoint.now ?? Date.now
  let refreshing: Promise<ChatGptTokens> | undefined
  const refresh = (current: ChatGptTokens): Promise<ChatGptTokens> => {
    refreshing ??= refreshChatGptTokens({ ...endpoint, tokens: current })
      .then(async (next) => {
        await store.write(next)
        return next
      })
      .catch(async (cause: unknown) => {
        if (cause instanceof ChatGptLoginError && cause.reason === "refresh_rejected") {
          const stored = await store.read().catch(() => undefined)
          if (stored?.refresh === current.refresh) await store.remove()
        }
        throw cause
      })
      .finally(() => {
        refreshing = undefined
      })
    return refreshing
  }
  return {
    get: async ({ forceRefresh = false } = {}) => {
      const current = await store.read()
      if (current === undefined) return undefined
      const fresh =
        forceRefresh || current.expires <= now() + REFRESH_MARGIN_MS
          ? await refresh(current)
          : current
      return { accessToken: fresh.access, accountId: fresh.accountId }
    }
  }
}

export const chatGptLoginFile = (folder: string): ChatGptLoginStore => {
  const path = join(folder, CHATGPT_LOGIN_FILE)
  return {
    read: async () => {
      let text: string
      try {
        text = await readFile(path, "utf8")
      } catch (cause) {
        if (isRecord(cause) && cause["code"] === "ENOENT") return undefined
        throw new ChatGptLoginError("unreadable_store")
      }
      const tokens = storedTokens(parseJson(text))
      if (tokens === undefined) throw new ChatGptLoginError("unreadable_store")
      return tokens
    },
    write: async (tokens) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeAtomic(path, `${JSON.stringify(storedJson(tokens), null, 2)}\n`, { mode: 0o600 })
    },
    remove: () => rm(path, { force: true })
  }
}

const postToken = async (
  fetchImpl: typeof fetch,
  issuer: string,
  contentType: string,
  body: string | URLSearchParams
): Promise<Response> => {
  try {
    return await fetchImpl(new URL("/oauth/token", issuer), {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    })
  } catch {
    throw new ChatGptLoginError("token_exchange")
  }
}

const bodyOf = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    throw new ChatGptLoginError("token_exchange")
  }
}

const tokensFromResponse = (
  value: unknown,
  now: number,
  previous: ChatGptTokens | undefined
): ChatGptTokens => {
  if (!isRecord(value)) throw new ChatGptLoginError("token_exchange")
  const access = nonEmpty(value["access_token"])
  const refresh = nonEmpty(value["refresh_token"]) ?? previous?.refresh
  if (access === undefined || refresh === undefined) throw new ChatGptLoginError("token_exchange")
  const expiresIn = value["expires_in"]
  const seconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : 3_600
  return {
    access,
    refresh,
    expires: now + Math.trunc(seconds * 1_000),
    accountId:
      accountIdOf(claimsOf(value["id_token"])) ??
      accountIdOf(claimsOf(access)) ??
      previous?.accountId
  }
}

const claimsOf = (token: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (typeof token !== "string") return undefined
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  const claims = parseJson(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"))
  return isRecord(claims) ? claims : undefined
}

const accountIdOf = (
  claims: Readonly<Record<string, unknown>> | undefined
): string | undefined => {
  if (claims === undefined) return undefined
  const auth = claims["https://api.openai.com/auth"]
  const organizations = claims["organizations"]
  const first: unknown = Array.isArray(organizations) ? organizations[0] : undefined
  return (
    nonEmpty(claims["chatgpt_account_id"]) ??
    (isRecord(auth) ? nonEmpty(auth["chatgpt_account_id"]) : undefined) ??
    (isRecord(first) ? nonEmpty(first["id"]) : undefined)
  )
}

const hasPermanentRefreshCode = (value: unknown, depth: number): boolean => {
  if (typeof value === "string") return PERMANENT_REFRESH_CODES.has(value)
  if (!isRecord(value) || depth >= 4) return false
  return (
    hasPermanentRefreshCode(value["error"], depth + 1) ||
    hasPermanentRefreshCode(value["code"], depth + 1)
  )
}

const storedJson = (tokens: ChatGptTokens): Record<string, unknown> => ({
  type: "oauth",
  access: tokens.access,
  refresh: tokens.refresh,
  expires: tokens.expires,
  ...(tokens.accountId === undefined ? {} : { accountId: tokens.accountId })
})

const storedTokens = (value: unknown): ChatGptTokens | undefined => {
  if (!isRecord(value)) return undefined
  const access = nonEmpty(value["access"])
  const refresh = nonEmpty(value["refresh"])
  const expires = value["expires"]
  if (access === undefined || refresh === undefined) return undefined
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) return undefined
  return { access, refresh, expires: Math.trunc(expires), accountId: nonEmpty(value["accountId"]) }
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const toLoginError = (cause: unknown): Error =>
  cause instanceof ChatGptLoginError ? cause : new ChatGptLoginError("token_exchange")

const respond = (response: ServerResponse, ok: boolean): void => {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Arden</title></head><body style="font-family:system-ui;padding:48px"><h1>${ok ? "Signed in" : "Sign-in failed"}</h1><p>${ok ? "You can close this window." : "Return to the terminal and try again."}</p></body></html>`
  response.writeHead(ok ? 200 : 400, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"
  })
  response.end(body)
}
