import type { GitHubConnectionState, GitHubConnectRequest } from "@arden-hq/protocol/mcp"
import { Schema } from "effect"

import {
  decodeVaultValue,
  readSecureDocument,
  requireVault,
  vaultOperation,
  writeSecureDocument,
  type CredentialVault
} from "../credentials/vault.js"

/**
 * GitHub's remote MCP server takes one bearer: a personal access token the
 * owner pastes or an OAuth user token.
 */

export class McpCredentialUnavailable extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = "McpCredentialUnavailable"
  }
}

export class GitHubTokenRejected extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = "GitHubTokenRejected"
  }
}

export interface GitHubChoice {
  readonly token: string
  readonly readOnly: boolean
}

type GitHubUserCheck =
  | { readonly kind: "ok"; readonly login: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" }

export interface McpTokenAuth {
  readonly headers: () => Promise<Readonly<Record<string, string>>>
  readonly identify: () => Promise<string>
}

const USER_TIMEOUT_MS = 10_000
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,512}$/

const NOT_CONNECTED = "Sign in to GitHub or paste a token to connect."
const NOT_ANSWERING = "GitHub isn’t answering right now. Try again in a few minutes."

const appSettingsTarget = { documentKey: "mcp:github:settings", binding: "preset:github" } as const
const AppSettingsSchema = Schema.Struct({ read_only: Schema.Boolean })

const documentTarget = { documentKey: "mcp:github", binding: "preset:github" } as const

const StoredChoiceSchema = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String.check(Schema.isPattern(TOKEN_PATTERN)),
  read_only: Schema.Boolean
})

const GitHubUserSchema = Schema.Struct({
  login: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
})

const githubMcpHeaders = ({ token, readOnly }: GitHubChoice): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  ...(readOnly ? { "X-MCP-Readonly": "true" } : {})
})

const fetchGitHubLogin = async (token: string): Promise<GitHubUserCheck> => {
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Arden",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(USER_TIMEOUT_MS)
    })
    if (response.status === 401) return { kind: "rejected" }
    if (!response.ok) return { kind: "unavailable" }
    const body: unknown = await response.json()
    return Schema.is(GitHubUserSchema)(body)
      ? { kind: "ok", login: body.login }
      : { kind: "unavailable" }
  } catch {
    return { kind: "unavailable" }
  }
}

export const makeGitHubConnection = ({
  vault,
  oauth
}: {
  readonly vault: CredentialVault | undefined
  readonly oauth?: {
    readonly token: () => Promise<string | undefined>
    readonly hasGrant: () => Promise<boolean>
    readonly clear: () => Promise<void>
  }
}) => {
  let loaded: { readonly choice: GitHubChoice | undefined } | undefined

  const readChoice = async (): Promise<GitHubChoice | undefined> => {
    if (loaded !== undefined) return loaded.choice
    const value = await readSecureDocument(vault, documentTarget)
    const stored =
      value === null
        ? undefined
        : await decodeVaultValue(StoredChoiceSchema, value, "Secure GitHub token is invalid")
    const choice =
      stored === undefined ? undefined : { token: stored.token, readOnly: stored.read_only }
    loaded = { choice }
    return choice
  }

  const saveChoice = async (choice: GitHubChoice): Promise<void> => {
    await writeSecureDocument(vault, documentTarget, {
      version: 1,
      token: choice.token,
      read_only: choice.readOnly
    })
    loaded = { choice }
  }

  const appReadOnly = async (): Promise<boolean> => {
    const value = await readSecureDocument(vault, appSettingsTarget)
    return value === null
      ? true
      : (await decodeVaultValue(AppSettingsSchema, value, "Secure GitHub settings are invalid"))
          .read_only
  }
  const requireChoice = async (): Promise<GitHubChoice> => {
    const choice = await readChoice()
    if (choice !== undefined) return choice
    const token = await oauth?.token()
    if (token === undefined) throw new McpCredentialUnavailable(NOT_CONNECTED)
    return { token, readOnly: await appReadOnly() }
  }

  const auth: McpTokenAuth = {
    headers: async () => githubMcpHeaders(await requireChoice()),
    identify: async () => {
      const check = await fetchGitHubLogin((await requireChoice()).token)
      switch (check.kind) {
        case "ok":
          return check.login
        case "rejected":
          throw new McpCredentialUnavailable(
            (await readChoice()) === undefined
              ? "GitHub authorization expired. Sign in again."
              : "GitHub turned down the token. Paste a new one."
          )
        case "unavailable":
          throw new Error(NOT_ANSWERING)
      }
    }
  }

  return {
    auth,
    // GitHub's notifications endpoint rejects app user tokens.
    token: async (): Promise<string | undefined> => (await readChoice())?.token,
    state: async (): Promise<GitHubConnectionState> => {
      const choice = await readChoice()
      if (choice !== undefined)
        return { connection: { readOnly: choice.readOnly, source: "token" } }
      return {
        connection: (await oauth?.hasGrant())
          ? { readOnly: await appReadOnly(), source: "app" }
          : null
      }
    },
    connect: async (request: GitHubConnectRequest): Promise<void> => {
      const check = await fetchGitHubLogin(request.token)
      if (check.kind === "unavailable") throw new Error(NOT_ANSWERING)
      if (check.kind === "rejected") {
        throw new GitHubTokenRejected("GitHub turned down that token. Check it and paste again.")
      }
      const readOnly = (await readChoice())?.readOnly ?? (await appReadOnly())
      await oauth?.clear()
      await saveChoice({ token: request.token, readOnly })
    },
    setReadOnly: async (readOnly: boolean): Promise<void> => {
      const choice = await readChoice()
      if (choice !== undefined) {
        await saveChoice({ ...choice, readOnly })
        return
      }
      if (!(await oauth?.hasGrant())) throw new GitHubTokenRejected(NOT_CONNECTED)
      await writeSecureDocument(vault, appSettingsTarget, { read_only: readOnly })
    },
    useApp: async (): Promise<void> => {
      await vaultOperation("Secure credentials could not be cleared", () =>
        requireVault(vault).clearDocument(documentTarget)
      )
      loaded = { choice: undefined }
    },
    forget: async (): Promise<void> => {
      await oauth?.clear()
      await vaultOperation("Secure GitHub settings could not be cleared", () =>
        requireVault(vault).clearDocument(appSettingsTarget)
      )
      await vaultOperation("Secure credentials could not be cleared", () =>
        requireVault(vault).clearDocument(documentTarget)
      )
      loaded = { choice: undefined }
    }
  }
}
