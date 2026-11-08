import { Encoding, Result, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { OpenAiCredentialSnapshot, OpenAiCredentialSource } from "../openai-responses/index.js"

const AuthFile = Schema.fromJsonString(
  Schema.Struct({
    tokens: Schema.Struct({
      access_token: Schema.String.check(Schema.isMinLength(1)),
      account_id: Schema.optionalKey(Schema.String)
    })
  })
)
const Claims = Schema.fromJsonString(Schema.Struct({ exp: Schema.optionalKey(Schema.Number) }))

const decodeAuthFile = Schema.decodeUnknownSync(AuthFile)
const decodeClaims = Schema.decodeUnknownSync(Claims)

export class CodexLoginError extends Error {}

/** The Codex CLI rule: a non-empty `CODEX_HOME`, else `~/.codex`
 *  (codex-rs/utils/home-dir/src/lib.rs, `find_codex_home`). */
export const codexHome = (env: NodeJS.ProcessEnv = process.env): string => {
  const configured = env.CODEX_HOME
  return configured === undefined || configured === "" ? join(homedir(), ".codex") : configured
}

const parseCodexAuth = (text: string, now: number): OpenAiCredentialSnapshot => {
  let accessToken: string
  let accountId: string | undefined
  try {
    const auth = decodeAuthFile(text)
    accessToken = auth.tokens.access_token
    accountId = auth.tokens.account_id
  } catch {
    throw new CodexLoginError("the Codex login file has no access token")
  }
  let exp: number | undefined
  try {
    exp = decodeClaims(
      Result.getOrThrow(Encoding.decodeBase64UrlString(accessToken.split(".")[1] ?? ""))
    ).exp
  } catch {
    throw new CodexLoginError("the Codex access token is not readable")
  }
  if (exp !== undefined && exp * 1000 <= now) throw new CodexLoginError("the Codex login expired")
  return accountId === undefined || accountId === ""
    ? { accessToken }
    : { accessToken, headers: { "chatgpt-account-id": accountId } }
}

export const codexCliCredentials = (
  options: { readonly env?: NodeJS.ProcessEnv; readonly now?: () => number } = {}
): OpenAiCredentialSource => {
  const read = async (): Promise<OpenAiCredentialSnapshot> => {
    const file = join(codexHome(options.env), "auth.json")
    const text = await readFile(file, "utf8").catch(() => {
      throw new CodexLoginError(`no Codex login at ${file}`)
    })
    return parseCodexAuth(text, (options.now ?? Date.now)())
  }
  return { get: read }
}
