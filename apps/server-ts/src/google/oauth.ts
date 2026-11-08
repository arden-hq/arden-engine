import type {
  GoogleOAuthClient,
  GoogleOAuthStartResponse,
  GoogleServiceId
} from "@arden-hq/protocol/google"
import { Predicate, Schema } from "effect"
import { randomBytes } from "node:crypto"

import { listenLoopback, type LoopbackListener } from "../connections/loopback-callback.js"
import {
  accountId,
  type GoogleAccountStore,
  sortedUnique,
  type StoredAccount,
  type StoredAuthorization,
  validEmail
} from "./account-store.js"
import type { createGoogleClientConfiguration } from "./client-configuration.js"
import { currentMillis, iso } from "../runtime/clock.js"
import { GoogleConnectionError } from "./errors.js"
import { sha256Base64Url } from "@arden-hq/std/hash"

const CALLBACK_PATH = "/oauth/callback"
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000

export const DEFAULT_GOOGLE_ENDPOINTS = {
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userInfo: "https://openidconnect.googleapis.com/v1/userinfo"
} as const

export interface GoogleEndpoints {
  readonly authorization: string
  readonly token: string
  readonly userInfo: string
}

export const GOOGLE_SCOPES: Readonly<Record<GoogleServiceId, ReadonlyArray<string>>> = {
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid"
  ],
  calendar: [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid"
  ],
  google_drive: [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid"
  ]
}

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  expires_in: Schema.Number.check(Schema.isFinite()),
  token_type: Schema.String,
  refresh_token: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536))
  ),
  id_token: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536))
  ),
  scope: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32_768)))
})
const decodeTokenResponse = Schema.decodeUnknownSync(TokenResponseSchema)
export const UserInfoSchema = Schema.Struct({
  sub: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)),
  email_verified: Schema.Boolean
})
export const decodeUserInfo = Schema.decodeUnknownSync(UserInfoSchema)

export interface GoogleIncrementalGrant {
  readonly accountId: string
  readonly email: string
  readonly scopes: ReadonlyArray<string>
}

interface PendingAuthorization {
  readonly controller: AbortController
  readonly client: GoogleOAuthClient
  readonly service: GoogleServiceId
  readonly required: ReadonlyArray<string>
  readonly accountId: string | undefined
  readonly verifier: string
  readonly redirectUri: string
  readonly listener: LoopbackListener
  readonly timer: ReturnType<typeof setTimeout>
}

const codeChallenge = (verifier: string): string => sha256Base64Url(verifier)

const authorizationParameters = ({
  service,
  incremental
}: {
  readonly service: GoogleServiceId
  readonly incremental: GoogleIncrementalGrant | undefined
}): { readonly scope: string; readonly extra: Readonly<Record<string, string>> } =>
  incremental === undefined
    ? { scope: GOOGLE_SCOPES[service].join(" "), extra: { include_granted_scopes: "true" } }
    : {
        scope: sortedUnique([...GOOGLE_SCOPES[service], ...incremental.scopes]).join(" "),
        extra: { include_granted_scopes: "true", login_hint: incremental.email }
      }

const requestJson = async (
  fetcher: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  operation: string
): Promise<unknown> => {
  let response: Response
  try {
    response = await fetcher(input, init)
  } catch (cause) {
    throw new GoogleConnectionError({
      reason: "provider",
      message: `Google ${operation} is unavailable`,
      cause
    })
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    throw new GoogleConnectionError({
      reason: "invalid_response",
      message: `Google ${operation} returned invalid data`,
      cause
    })
  }
  if (!response.ok) {
    const oauthError =
      Predicate.isObject(body) && typeof body.error === "string" ? body.error : undefined
    throw new GoogleConnectionError({
      reason: oauthError === "invalid_grant" ? "auth_required" : "provider",
      message:
        oauthError === "invalid_grant"
          ? "Google authorization expired or was revoked"
          : `Google ${operation} failed (${oauthError ?? "unknown_error"})`
    })
  }
  return body
}

export const makeGoogleOAuth = ({
  store,
  clientConfiguration,
  fetcher,
  endpoints,
  now
}: {
  readonly store: GoogleAccountStore
  readonly clientConfiguration: ReturnType<typeof createGoogleClientConfiguration>
  readonly fetcher: typeof globalThis.fetch
  readonly endpoints: GoogleEndpoints
  readonly now: () => number
}) => {
  const pending = new Map<GoogleServiceId, PendingAuthorization>()

  const closePending = async (service: GoogleServiceId): Promise<void> => {
    const authorization = pending.get(service)
    if (authorization === undefined) return
    pending.delete(service)
    authorization.controller.abort()
    clearTimeout(authorization.timer)
    await authorization.listener.close()
  }

  const exchange = async (
    service: GoogleServiceId,
    code: string,
    authorization: PendingAuthorization
  ): Promise<void> => {
    const client = authorization.client
    if (client === undefined) {
      throw new GoogleConnectionError({
        reason: "not_configured",
        message: "Set up your Google client in Settings → Connections"
      })
    }
    const form = new URLSearchParams({
      client_id: client.clientId,
      code,
      code_verifier: authorization.verifier,
      grant_type: "authorization_code",
      redirect_uri: authorization.redirectUri
    })
    if (client.clientSecret !== undefined && client.clientSecret !== "") {
      form.set("client_secret", client.clientSecret)
    }
    const rawToken = await requestJson(
      fetcher,
      endpoints.token,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: authorization.controller.signal
      },
      "token exchange"
    )
    let token: typeof TokenResponseSchema.Type
    try {
      token = decodeTokenResponse(rawToken)
    } catch (cause) {
      throw new GoogleConnectionError({
        reason: "invalid_response",
        message: "Google returned invalid credentials",
        cause
      })
    }
    if (token.token_type.toLowerCase() !== "bearer" || token.expires_in <= 0) {
      throw new GoogleConnectionError({
        reason: "invalid_response",
        message: "Google returned invalid credentials"
      })
    }
    const rawUser = await requestJson(
      fetcher,
      endpoints.userInfo,
      {
        headers: { authorization: `Bearer ${token.access_token}` },
        signal: authorization.controller.signal
      },
      "account verification"
    )
    let user: typeof UserInfoSchema.Type
    try {
      user = decodeUserInfo(rawUser)
    } catch (cause) {
      throw new GoogleConnectionError({
        reason: "invalid_response",
        message: "Google returned an invalid account",
        cause
      })
    }
    if (!user.email_verified || !validEmail(user.email)) {
      throw new GoogleConnectionError({
        reason: "invalid_response",
        message: "Google did not return a verified email"
      })
    }

    const granted = sortedUnique((token.scope ?? "").split(/\s+/u).filter(Boolean))
    if (authorization.accountId !== undefined && accountId(user.sub) !== authorization.accountId) {
      throw new GoogleConnectionError({
        reason: "invalid_response",
        message: "Google signed in a different account"
      })
    }
    if (authorization.required.some((scope) => !granted.includes(scope))) {
      throw new GoogleConnectionError({
        reason: "auth_required",
        message: "Google authorization is missing permissions"
      })
    }

    await store.serial(async () => {
      const state = await store.read()
      const id = accountId(user.sub)
      const existing = state.accounts.find((account) => account.id === id)
      if (existing !== undefined && existing.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new GoogleConnectionError({
          reason: "invalid_response",
          message: "Google account identity changed"
        })
      }
      const previous = existing?.authorizations.find((item) => item.service === service)
      const refreshToken = token.refresh_token ?? previous?.token.refreshToken
      if (refreshToken === undefined) {
        throw new GoogleConnectionError({
          reason: "auth_required",
          message: "Google did not grant offline access"
        })
      }
      const nextAuthorization: StoredAuthorization = {
        service,
        scopes: granted,
        status: "ready",
        token: {
          accessToken: token.access_token,
          refreshToken,
          expiresAt: now() + token.expires_in * 1_000,
          tokenType: "Bearer"
        }
      }
      const nextAccount: StoredAccount = {
        id,
        email: user.email,
        authorizations: [
          ...(existing?.authorizations.filter((item) => item.service !== service) ?? []),
          nextAuthorization
        ]
      }
      if (pending.get(service) !== authorization || authorization.controller.signal.aborted) {
        throw new GoogleConnectionError({
          reason: "auth_required",
          message: "Google sign-in was cancelled"
        })
      }
      await store.write({
        version: 1,
        accounts: [...state.accounts.filter((account) => account.id !== id), nextAccount]
      })
    })
  }

  const startOAuth = async (
    service: GoogleServiceId,
    incremental?: GoogleIncrementalGrant
  ): Promise<GoogleOAuthStartResponse> => {
    const client = await clientConfiguration.read()
    if (client === undefined || client.clientId.trim() === "") {
      throw new GoogleConnectionError({
        reason: "not_configured",
        message: "Set up your Google client in Settings → Connections"
      })
    }
    void closePending(service)
    const state = randomBytes(32).toString("base64url")
    const verifier = randomBytes(64).toString("base64url")
    let listener: LoopbackListener
    try {
      listener = await listenLoopback({
        port: "ephemeral",
        path: CALLBACK_PATH,
        respond: async ({ method, params }) => {
          if (method !== "GET") return { status: 404, type: "text", body: "Not found" }
          if (params.get("state") !== state) {
            return {
              status: 400,
              type: "text",
              body: "Google sign-in could not be verified. Return to Arden and try again."
            }
          }
          const code = params.get("code")
          try {
            if (code === null || code === "") {
              return {
                status: 400,
                type: "text",
                body: "Google sign-in was not completed. Return to Arden and try again."
              }
            }
            await exchange(service, code, authorization)
            return {
              status: 200,
              type: "html",
              body: "<!doctype html><title>Arden connected</title><p>Google is connected. You can close this tab and return to Arden.</p>"
            }
          } catch (cause) {
            return {
              status: 500,
              type: "text",
              body:
                cause instanceof GoogleConnectionError
                  ? `${cause.message}. Return to Arden and try again.`
                  : "Google sign-in failed. Return to Arden and try again."
            }
          } finally {
            if (pending.get(service) === authorization) void closePending(service)
          }
        }
      })
    } catch (cause) {
      throw new GoogleConnectionError({
        reason: "provider",
        message: "Google sign-in callback could not start",
        cause
      })
    }
    const redirectUri = listener.redirectUri
    const timer = setTimeout(() => void closePending(service), CALLBACK_TIMEOUT_MS)
    const parameters = authorizationParameters({ service, incremental })
    const authorization: PendingAuthorization = {
      controller: new AbortController(),
      client,
      service,
      required: parameters.scope.split(" "),
      accountId: incremental?.accountId,
      verifier,
      redirectUri,
      listener,
      timer
    }
    pending.set(service, authorization)

    const url = new URL(endpoints.authorization)
    url.search = new URLSearchParams({
      access_type: "offline",
      client_id: client.clientId,
      code_challenge: codeChallenge(verifier),
      code_challenge_method: "S256",
      prompt: "consent",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: parameters.scope,
      state,
      ...parameters.extra
    }).toString()
    return {
      service,
      authorizationUrl: url.href,
      expiresAt: iso(currentMillis() + CALLBACK_TIMEOUT_MS),
      status: "pending"
    }
  }

  const refresh = async (
    account: StoredAccount,
    authorization: StoredAuthorization
  ): Promise<StoredAuthorization> => {
    const client = await clientConfiguration.read()
    if (client === undefined || authorization.token.refreshToken === undefined) {
      await store.markNeedsAuth(account.id, authorization.service)
      throw new GoogleConnectionError({
        reason: "auth_required",
        message: "Google authorization must be renewed"
      })
    }
    const form = new URLSearchParams({
      client_id: client.clientId,
      grant_type: "refresh_token",
      refresh_token: authorization.token.refreshToken
    })
    if (client.clientSecret !== undefined && client.clientSecret !== "") {
      form.set("client_secret", client.clientSecret)
    }
    let raw: unknown
    try {
      raw = await requestJson(
        fetcher,
        endpoints.token,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form
        },
        "token refresh"
      )
    } catch (cause) {
      if (cause instanceof GoogleConnectionError && cause.reason === "auth_required") {
        await store.markNeedsAuth(account.id, authorization.service)
      }
      throw cause
    }
    let token: typeof TokenResponseSchema.Type
    try {
      token = decodeTokenResponse(raw)
    } catch (cause) {
      throw new GoogleConnectionError({
        reason: "invalid_response",
        message: "Google returned invalid credentials",
        cause
      })
    }
    const next: StoredAuthorization = {
      ...authorization,
      scopes:
        token.scope === undefined
          ? authorization.scopes
          : sortedUnique(token.scope.split(/\s+/u).filter(Boolean)),
      status: "ready",
      token: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? authorization.token.refreshToken,
        expiresAt: now() + token.expires_in * 1_000,
        tokenType: "Bearer"
      }
    }
    await store.serial(async () => {
      const state = await store.read()
      await store.write({
        version: 1,
        accounts: state.accounts.map((candidate) =>
          candidate.id !== account.id
            ? candidate
            : {
                ...candidate,
                authorizations: candidate.authorizations.map((item) =>
                  item.service === authorization.service ? next : item
                )
              }
        )
      })
    })
    return next
  }

  return {
    startOAuth,
    refresh,
    hasPending: () => pending.size > 0,
    pendingServices: () => [...pending.keys()],
    close: async (): Promise<void> => {
      await Promise.all([...pending.keys()].map(closePending))
    }
  }
}
