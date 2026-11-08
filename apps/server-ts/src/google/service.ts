import { accountReadyFor } from "@arden-hq/protocol/google"
import type {
  GoogleClientConfigured,
  GoogleOAuthClient,
  GoogleAccount,
  GoogleAccountListResponse,
  GoogleDisconnectReceipt,
  GoogleGrant,
  GoogleOAuthStartResponse,
  GoogleServiceId
} from "@arden-hq/protocol/google"
import { GOOGLE_GRANTS } from "@arden-hq/protocol/google"
import { createGoogleClientConfiguration } from "./client-configuration.js"
export type { GoogleOAuthClient } from "@arden-hq/protocol/google"
import { Context, Effect, Layer } from "effect"
import { sleep } from "@arden-hq/std/sleep"

import type { CredentialVault } from "../credentials/vault.js"
import { VaultError } from "../credentials/vault.js"
import {
  makeGoogleAccountStore,
  publicAccount,
  publicAccounts,
  accountId,
  validEmail
} from "./account-store.js"
import { GoogleConnectionError } from "./errors.js"
import {
  decodeUserInfo,
  DEFAULT_GOOGLE_ENDPOINTS,
  GOOGLE_SCOPES,
  type GoogleEndpoints,
  makeGoogleOAuth,
  type UserInfoSchema
} from "./oauth.js"
import {
  GOOGLE_API_MAX_ATTEMPTS,
  GOOGLE_RETRY_MAX_DELAY_MS,
  googleApiDiagnostic,
  googleApiErrorMessage,
  googleRetryDelayMs
} from "./request-policy.js"
import { currentMillis } from "../runtime/clock.js"
import { googleBinaryResponse } from "./binary-response.js"

const ACCESS_TOKEN_SKEW_MS = 60_000

export interface GoogleServiceOptions {
  readonly vault?: CredentialVault | undefined
  readonly oauthClient?: GoogleOAuthClient | undefined
  readonly endpoints?: Partial<GoogleEndpoints>
  readonly now?: () => number
  readonly random?: () => number
  readonly retrySleep?: (delayMs: number, signal: AbortSignal | undefined) => Promise<void>
}

const googleAuthorizationError = (cause: unknown): GoogleConnectionError => {
  if (cause instanceof GoogleConnectionError) return cause
  if (cause instanceof VaultError) {
    return new GoogleConnectionError({
      reason: "storage",
      message: "Google credentials are unavailable",
      cause
    })
  }
  return new GoogleConnectionError({
    reason: "provider",
    message: "Google authorization failed",
    cause
  })
}

interface GoogleAccountAccess {
  readonly allowedAccountIds: () => Promise<ReadonlyArray<string> | null>
}

interface GoogleApiRequest {
  readonly service: GoogleServiceId
  readonly url: string
  readonly init?: RequestInit | undefined
  readonly accountRef?: string | undefined
  readonly access?: GoogleAccountAccess | undefined
  readonly response?: { readonly kind: "binary"; readonly maxBytes: number }
}

interface GoogleConnectionsShape {
  readonly cancelOAuth: () => Effect.Effect<{ readonly status: "cancelled" }, GoogleConnectionError>
  readonly prepareClientReplacement: (disconnectAccounts: boolean) => Effect.Effect<
    | { readonly status: "ready" }
    | {
        readonly status: "blocked"
        readonly reason: "accounts_connected" | "authorization_pending"
      },
    GoogleConnectionError
  >
  readonly configureClient: (
    client: GoogleOAuthClient
  ) => Effect.Effect<GoogleClientConfigured, GoogleConnectionError>
  readonly list: () => Effect.Effect<GoogleAccountListResponse, GoogleConnectionError>
  readonly accounts: () => ReadonlyArray<GoogleAccount>
  readonly startOAuth: (
    service: GoogleServiceId
  ) => Effect.Effect<GoogleOAuthStartResponse, GoogleConnectionError>
  readonly startGrantOAuth: (
    grant: GoogleGrant,
    accountId: string
  ) => Effect.Effect<GoogleOAuthStartResponse, GoogleConnectionError>
  readonly disconnect: (
    service: GoogleServiceId,
    accountId: string
  ) => Effect.Effect<GoogleDisconnectReceipt, GoogleConnectionError>
  readonly accessToken: (input: {
    readonly service: GoogleServiceId
    readonly accountRef?: string
    readonly forceRefresh?: boolean
  }) => Effect.Effect<
    { readonly account: GoogleAccount; readonly token: string },
    GoogleConnectionError
  >
  readonly verify: (
    service: GoogleServiceId,
    accountRef?: string
  ) => Effect.Effect<GoogleAccount, GoogleConnectionError>
  readonly request: (
    request: GoogleApiRequest
  ) => Effect.Effect<
    { readonly account: GoogleAccount; readonly value: unknown },
    GoogleConnectionError
  >
  readonly close: () => Promise<void>
}

export class GoogleConnections extends Context.Service<GoogleConnections, GoogleConnectionsShape>()(
  "@arden-hq/server/google/GoogleConnections"
) {}

const makeGoogleConnections = (options: GoogleServiceOptions): GoogleConnectionsShape => {
  const clientConfiguration = createGoogleClientConfiguration({
    vault: options.vault,
    seed: options.oauthClient
  })
  const fetcher = globalThis.fetch
  const endpoints: GoogleEndpoints = { ...DEFAULT_GOOGLE_ENDPOINTS, ...options.endpoints }
  const now = options.now ?? currentMillis
  const random = options.random ?? Math.random
  const retrySleep =
    options.retrySleep ??
    ((delayMs: number, signal: AbortSignal | undefined) => sleep(delayMs, signal))
  const store = makeGoogleAccountStore(options.vault)
  const oauth = makeGoogleOAuth({ store, clientConfiguration, fetcher, endpoints, now })

  const accessToken = async ({
    service,
    accountRef,
    forceRefresh = false,
    access
  }: {
    readonly service: GoogleServiceId
    readonly accountRef?: string | undefined
    readonly forceRefresh?: boolean
    readonly access?: GoogleAccountAccess | undefined
  }): Promise<{ readonly account: GoogleAccount; readonly token: string }> => {
    const state = await store.serial(store.read)
    const allowedIds = access === undefined ? null : await access.allowedAccountIds()
    const permitted = state.accounts.filter((account) => {
      const matches =
        accountRef === undefined ||
        account.id === accountRef ||
        account.email.toLowerCase() === accountRef.toLowerCase()
      return matches && (allowedIds === null || allowedIds.includes(account.id))
    })
    if (allowedIds !== null && permitted.length === 0) {
      throw new GoogleConnectionError({
        reason: "access_denied",
        message: "This Run does not have access to that Google account and service"
      })
    }
    const candidates = permitted.filter((account) => accountReadyFor(account, service))
    if (candidates.length === 0) {
      throw new GoogleConnectionError({
        reason: "auth_required",
        message: `No ${service} account is connected`
      })
    }
    if (candidates.length > 1) {
      throw new GoogleConnectionError({
        reason: "not_found",
        message: `Choose an account: ${candidates.map((item) => item.email).join(", ")}`
      })
    }
    const account = candidates[0]
    if (account === undefined)
      throw new GoogleConnectionError({
        reason: "auth_required",
        message: "Google account is unavailable"
      })
    const authorization = account.authorizations.find((item) => item.service === service)
    if (authorization === undefined) {
      throw new GoogleConnectionError({
        reason: "auth_required",
        message: `No ${service} account is connected`
      })
    }
    const active =
      forceRefresh || authorization.token.expiresAt <= now() + ACCESS_TOKEN_SKEW_MS
        ? await oauth.refresh(account, authorization)
        : authorization
    return { account: publicAccount(account), token: active.token.accessToken }
  }

  const apiRequest = async ({
    service,
    url,
    init = {},
    accountRef,
    access,
    response: responseMode
  }: GoogleApiRequest): Promise<{ readonly account: GoogleAccount; readonly value: unknown }> => {
    const signal = init.signal ?? undefined
    const method = (init.method ?? "GET").toUpperCase()
    const safeToRetry = method === "GET" || method === "HEAD"
    const waitForRetry = async (
      attempt: number,
      retryAfterMs: number | undefined
    ): Promise<void> => {
      await retrySleep(googleRetryDelayMs(attempt, retryAfterMs, random()), signal)
    }
    const execute = async (
      forceRefresh: boolean,
      attempt: number
    ): Promise<{ readonly account: GoogleAccount; readonly value: unknown }> => {
      const credential = await accessToken({ service, accountRef, forceRefresh, access })
      const allowedIds = access === undefined ? null : await access.allowedAccountIds()
      if (allowedIds !== null && !allowedIds.includes(credential.account.id)) {
        throw new GoogleConnectionError({
          reason: "access_denied",
          message: "This Run no longer has access to that Google account and service"
        })
      }
      let response: Response
      try {
        const headers = new Headers(init.headers)
        headers.set("authorization", `Bearer ${credential.token}`)
        response = await fetcher(url, {
          ...init,
          headers
        })
      } catch (cause) {
        if (signal?.aborted === true) throw cause
        const error = new GoogleConnectionError({
          reason: "provider",
          message: "Google API could not be reached.",
          cause,
          diagnostic: { kind: "transport", retryable: safeToRetry }
        })
        if (!safeToRetry || attempt >= GOOGLE_API_MAX_ATTEMPTS) throw error
        await waitForRetry(attempt, undefined)
        return execute(forceRefresh, attempt + 1)
      }
      if (response.status === 401 && !forceRefresh) return execute(true, attempt)
      let value: unknown = null
      if (response.status !== 204) {
        try {
          value =
            response.ok && responseMode?.kind === "binary"
              ? await googleBinaryResponse(response, responseMode.maxBytes)
              : await response.json()
        } catch (cause) {
          if (signal?.aborted === true) throw cause
          if (!response.ok) value = null
          else {
            throw new GoogleConnectionError({
              reason: "invalid_response",
              message:
                responseMode?.kind === "binary" && cause instanceof Error
                  ? cause.message
                  : "Google API returned invalid data",
              cause,
              diagnostic: {
                kind: "http",
                status: response.status,
                reason: "provider",
                retryAfterMs: undefined,
                retryable: false
              }
            })
          }
        }
      }
      if (!response.ok) {
        if (response.status === 401) {
          await store.markNeedsAuth(credential.account.id, service)
        }
        const diagnostic = googleApiDiagnostic(response, value, now(), safeToRetry)
        const error = new GoogleConnectionError({
          reason: diagnostic.reason === "auth" ? "auth_required" : "provider",
          message: googleApiErrorMessage(diagnostic),
          diagnostic
        })
        if (
          !safeToRetry ||
          !diagnostic.retryable ||
          attempt >= GOOGLE_API_MAX_ATTEMPTS ||
          (diagnostic.retryAfterMs ?? 0) > GOOGLE_RETRY_MAX_DELAY_MS
        ) {
          throw error
        }
        await waitForRetry(attempt, diagnostic.retryAfterMs)
        return execute(forceRefresh, attempt + 1)
      }
      return { account: credential.account, value }
    }
    return execute(false, 1)
  }

  const verify = async (service: GoogleServiceId, accountRef?: string): Promise<GoogleAccount> => {
    if ((await clientConfiguration.read()) === undefined) {
      throw new GoogleConnectionError({
        reason: "not_configured",
        message: "Set up your Google client in Settings → Connections"
      })
    }
    await accessToken({ service, accountRef, forceRefresh: true })
    const verified = await apiRequest({ service, url: endpoints.userInfo, accountRef })
    let user: typeof UserInfoSchema.Type
    try {
      user = decodeUserInfo(verified.value)
    } catch (cause) {
      throw new GoogleConnectionError({
        reason: "invalid_response",
        message: "Google returned an invalid account",
        cause
      })
    }
    if (
      !user.email_verified ||
      !validEmail(user.email) ||
      accountId(user.sub) !== verified.account.id ||
      user.email.toLowerCase() !== verified.account.email.toLowerCase()
    ) {
      throw new GoogleConnectionError({
        reason: "invalid_response",
        message: "Google account identity changed"
      })
    }
    const state = await store.serial(store.read)
    const account = state.accounts.find((candidate) => candidate.id === verified.account.id)
    const authorization = account?.authorizations.find((item) => item.service === service)
    if (
      account === undefined ||
      authorization === undefined ||
      authorization.status !== "ready" ||
      GOOGLE_SCOPES[service].some((scope) => !authorization.scopes.includes(scope))
    ) {
      throw new GoogleConnectionError({
        reason: "auth_required",
        message: "Google authorization is missing permissions"
      })
    }
    return publicAccount(account)
  }

  return {
    cancelOAuth: () =>
      Effect.tryPromise({
        try: async () => {
          await oauth.close()
          return { status: "cancelled" } as const
        },
        catch: googleAuthorizationError
      }),
    prepareClientReplacement: (disconnectAccounts) =>
      Effect.tryPromise({
        try: async () => {
          await oauth.close()
          return store.serial(async () => {
            if (oauth.hasPending())
              return { status: "blocked", reason: "authorization_pending" } as const
            const state = await store.read()
            if (state.accounts.length > 0 && !disconnectAccounts)
              return { status: "blocked", reason: "accounts_connected" } as const
            if (state.accounts.length > 0) await store.write({ version: 1, accounts: [] })
            return { status: "ready" } as const
          })
        },
        catch: googleAuthorizationError
      }),
    configureClient: (client) =>
      Effect.tryPromise({
        try: () =>
          store.serial(async (): Promise<GoogleClientConfigured> => {
            const current = await clientConfiguration.read()
            if (
              current?.clientId === client.clientId &&
              current.clientSecret === client.clientSecret
            )
              return { status: "configured" }
            if (oauth.hasPending()) return { status: "blocked", reason: "authorization_pending" }
            if ((await store.read()).accounts.length > 0)
              return { status: "blocked", reason: "accounts_connected" }
            await clientConfiguration.write(client)
            return { status: "configured" }
          }),
        catch: () =>
          new GoogleConnectionError({
            reason: "storage",
            message: "The client file couldn’t be saved. Try again."
          })
      }),
    accounts: store.snapshot,
    list: () =>
      Effect.tryPromise({
        try: async () => ({
          pendingOAuth: oauth.pendingServices(),
          oauthConfigured: (await store.serial(() => clientConfiguration.read())) !== undefined,
          accounts: store.mirrored()
            ? store.snapshot()
            : publicAccounts(await store.serial(store.read))
        }),
        catch: (cause) =>
          cause instanceof GoogleConnectionError
            ? cause
            : new GoogleConnectionError({
                reason: "storage",
                message: "Google accounts could not be read",
                cause
              })
      }),
    startOAuth: (service) =>
      Effect.tryPromise({
        try: () => store.serial(() => oauth.startOAuth(service)),
        catch: (cause) =>
          cause instanceof GoogleConnectionError
            ? cause
            : new GoogleConnectionError({
                reason: "provider",
                message: "Google sign-in could not start",
                cause
              })
      }),
    startGrantOAuth: (grant, id) =>
      Effect.tryPromise({
        try: () =>
          store.serial(async () => {
            const { service, request } = GOOGLE_GRANTS[grant]
            const account = (await store.read()).accounts.find(
              (candidate) =>
                candidate.id === id &&
                candidate.authorizations.some((item) => item.service === service)
            )
            if (account === undefined) {
              throw new GoogleConnectionError({
                reason: "not_found",
                message: "Google account authorization was not found"
              })
            }
            return oauth.startOAuth(service, {
              accountId: account.id,
              email: account.email,
              scopes: [request]
            })
          }),
        catch: (cause) =>
          cause instanceof GoogleConnectionError
            ? cause
            : new GoogleConnectionError({
                reason: "provider",
                message: "Google sign-in could not start",
                cause
              })
      }),
    disconnect: (service, id) =>
      Effect.tryPromise({
        try: () =>
          store.serial(async () => {
            const state = await store.read()
            const account = state.accounts.find((candidate) => candidate.id === id)
            if (
              account === undefined ||
              !account.authorizations.some((item) => item.service === service)
            ) {
              throw new GoogleConnectionError({
                reason: "not_found",
                message: "Google account authorization was not found"
              })
            }
            const authorizations = account.authorizations.filter((item) => item.service !== service)
            await store.write({
              version: 1,
              accounts:
                authorizations.length === 0
                  ? state.accounts.filter((candidate) => candidate.id !== id)
                  : state.accounts.map((candidate) =>
                      candidate.id === id ? { ...candidate, authorizations } : candidate
                    )
            })
            return { status: "removed", service, accountId: id } as const
          }),
        catch: (cause) =>
          cause instanceof GoogleConnectionError
            ? cause
            : new GoogleConnectionError({
                reason: "storage",
                message: "Google authorization could not be removed",
                cause
              })
      }),
    accessToken: (input) =>
      Effect.tryPromise({
        try: () => accessToken(input),
        catch: googleAuthorizationError
      }),
    verify: (service, accountRef) =>
      Effect.tryPromise({
        try: () => verify(service, accountRef),
        catch: googleAuthorizationError
      }),
    request: (request) =>
      Effect.tryPromise({
        try: (signal) =>
          apiRequest({
            ...request,
            init: {
              ...request.init,
              signal: request.init?.signal ? AbortSignal.any([signal, request.init.signal]) : signal
            }
          }),
        catch: (cause) =>
          cause instanceof GoogleConnectionError
            ? cause
            : new GoogleConnectionError({
                reason: "provider",
                message: "Google API request failed",
                cause
              })
      }),
    close: oauth.close
  }
}

export const googleConnectionsLayer = (
  options: GoogleServiceOptions
): Layer.Layer<GoogleConnections> =>
  Layer.effect(
    GoogleConnections,
    Effect.acquireRelease(
      Effect.sync(() => makeGoogleConnections(options)).pipe(
        Effect.tap((service) =>
          service
            .list()
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Google account snapshot could not be primed", { cause })
              )
            )
        )
      ),
      (service) => Effect.promise(() => service.close())
    )
  )
