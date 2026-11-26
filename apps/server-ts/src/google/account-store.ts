import {
  GOOGLE_AUTHORIZATION_STATUS,
  type GoogleAccount,
  type GoogleServiceId
} from "@arden-hq/protocol/google"
import { GoogleServiceIdSchema } from "@arden-hq/protocol/effect/google"
import { Schema, type SchemaAST } from "effect"

import {
  readSecureDocument,
  type CredentialVault,
  type SecureDocumentTarget,
  writeSecureDocument
} from "../credentials/vault.js"
import { GoogleConnectionError } from "./errors.js"
import { sha256Base64Url } from "@arden-hq/std/hash"

const GOOGLE_ACCOUNTS_TARGET: SecureDocumentTarget = {
  documentKey: "google:accounts",
  binding: "google:v1"
}
const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }

export const GOOGLE_TOKEN_TYPE = { bearer: "Bearer" } as const

const ScopeSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const TokenSchema = Schema.Struct({
  accessToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  refreshToken: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536))
  ),
  expiresAt: Schema.Number.check(Schema.isFinite()),
  tokenType: Schema.Literal(GOOGLE_TOKEN_TYPE.bearer)
})
const StoredAuthorizationSchema = Schema.Struct({
  service: GoogleServiceIdSchema,
  scopes: Schema.Array(ScopeSchema),
  status: Schema.Literals(Object.values(GOOGLE_AUTHORIZATION_STATUS)),
  token: TokenSchema
})
const StoredAccountSchema = Schema.Struct({
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/)
  ),
  email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)),
  authorizations: Schema.Array(StoredAuthorizationSchema)
})
const StoreSchema = Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Array(StoredAccountSchema)
})
const decodeStore = Schema.decodeUnknownSync(StoreSchema)

export type StoredAuthorization = typeof StoredAuthorizationSchema.Type
export type StoredAccount = typeof StoredAccountSchema.Type
export type StoredState = typeof StoreSchema.Type

export const sortedUnique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort()

export const publicAccount = (account: StoredAccount): GoogleAccount => ({
  id: account.id,
  email: account.email,
  authorizations: [...account.authorizations]
    .sort((left, right) => left.service.localeCompare(right.service))
    .map((authorization) => ({
      service: authorization.service,
      scopes: sortedUnique(authorization.scopes),
      status: authorization.status
    }))
})

export const publicAccounts = (state: StoredState): ReadonlyArray<GoogleAccount> =>
  [...state.accounts]
    .sort((left, right) => left.email.localeCompare(right.email))
    .map(publicAccount)

export const validEmail = (value: string): boolean =>
  value === value.trim() && value.length <= 320 && /^[^@\s]+@[^@\s]+$/u.test(value)

export const accountId = (subject: string): string => `g_${sha256Base64Url(subject).slice(0, 32)}`

export interface GoogleAccountStore {
  readonly serial: <A>(operation: () => Promise<A>) => Promise<A>
  readonly read: () => Promise<StoredState>
  readonly write: (state: StoredState) => Promise<void>
  readonly markNeedsAuth: (accountIdValue: string, service: GoogleServiceId) => Promise<void>
  readonly snapshot: () => readonly GoogleAccount[]
  readonly mirrored: () => boolean
}

export const makeGoogleAccountStore = (vault: CredentialVault | undefined): GoogleAccountStore => {
  let snapshot: ReadonlyArray<GoogleAccount> = []
  let mirrored = false
  let tail: Promise<void> = Promise.resolve()

  const serial = <A>(operation: () => Promise<A>): Promise<A> => {
    const run = tail.then(operation, operation)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const read = async (): Promise<StoredState> => {
    if (vault === undefined) return { version: 1, accounts: [] }
    let value: unknown | null
    try {
      value = await readSecureDocument(vault, GOOGLE_ACCOUNTS_TARGET)
    } catch (cause) {
      throw new GoogleConnectionError({
        reason: "storage",
        message: "Google accounts could not be opened",
        cause
      })
    }
    if (value === null) {
      snapshot = []
      mirrored = true
      return { version: 1, accounts: [] }
    }
    let state: StoredState
    try {
      state = decodeStore(value, strict)
    } catch (cause) {
      throw new GoogleConnectionError({
        reason: "storage",
        message: "Google account storage is invalid",
        cause
      })
    }
    snapshot = publicAccounts(state)
    mirrored = true
    return state
  }

  const write = async (state: StoredState): Promise<void> => {
    const normalized: StoredState = {
      version: 1,
      accounts: [...state.accounts]
        .sort((left, right) => left.email.localeCompare(right.email))
        .map((account) => ({
          ...account,
          authorizations: [...account.authorizations]
            .sort((left, right) => left.service.localeCompare(right.service))
            .map((authorization) => ({
              ...authorization,
              scopes: sortedUnique(authorization.scopes)
            }))
        }))
    }
    try {
      await writeSecureDocument(vault, GOOGLE_ACCOUNTS_TARGET, normalized)
    } catch (cause) {
      throw new GoogleConnectionError({
        reason: "storage",
        message: "Google accounts could not be saved",
        cause
      })
    }
    snapshot = publicAccounts(normalized)
    mirrored = true
  }

  const markNeedsAuth = async (accountIdValue: string, service: GoogleServiceId): Promise<void> => {
    await serial(async () => {
      const state = await read()
      await write({
        version: 1,
        accounts: state.accounts.map((account) =>
          account.id !== accountIdValue
            ? account
            : {
                ...account,
                authorizations: account.authorizations.map((authorization) =>
                  authorization.service === service
                    ? { ...authorization, status: "needs_auth" as const }
                    : authorization
                )
              }
        )
      })
    })
  }

  return {
    serial,
    read,
    write,
    markNeedsAuth,
    snapshot: () => snapshot,
    mirrored: () => mirrored
  }
}
