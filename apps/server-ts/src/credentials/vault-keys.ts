import { Context, Layer, Schema, type SchemaAST } from "effect"

export const VAULT_USE_KEY_TOOL = "vault_use_key"

export const VaultKeyApprovalDataSchema = Schema.Struct({
  vault_key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  vault_key_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
})

type KeyProxyReach = "all" | "remote"

export interface VaultKeyBroker {
  readonly listVault: () => Promise<unknown>
  readonly keyEnvironment: (request: {
    readonly runId: string
    readonly ids: ReadonlyArray<string>
    readonly reach: KeyProxyReach
  }) => Promise<unknown>
  readonly findSecrets: (text: string) => Promise<unknown>
  readonly endKeySession: (runId: string) => Promise<unknown>
}

const Text = Schema.String.check(Schema.isMaxLength(2_048))

const VaultListSchema = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({ id: Text, name: Text, variable: Text, addresses: Schema.Array(Text) })
  ),
  passwords: Schema.Array(
    Schema.Struct({ site: Text, name: Text, userName: Schema.optionalKey(Text) })
  ),
  contacts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Text,
        email: Schema.optionalKey(Text),
        phone: Schema.optionalKey(Text),
        addressLine1: Schema.optionalKey(Text),
        addressLine2: Schema.optionalKey(Text),
        city: Schema.optionalKey(Text),
        postalCode: Schema.optionalKey(Text),
        region: Schema.optionalKey(Text),
        country: Schema.optionalKey(Text)
      })
    )
  ),
  cards: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Text.check(Schema.isPattern(/^[0-9a-f]{24}$/)),
        brand: Schema.Literals(["Visa", "Mastercard", "American Express", "Card"] as const),
        last4: Text.check(Schema.isPattern(/^[0-9]{4}$/)),
        expiry: Text.check(Schema.isPattern(/^[0-9]{2}\/[0-9]{2}$/)),
        nameOnCard: Text,
        billingName: Schema.optionalKey(Text)
      })
    )
  )
})
export type VaultList = typeof VaultListSchema.Type

const KeyEnvironmentSchema = Schema.Struct({
  variables: Schema.Record(Schema.String, Text),
  missing: Schema.Array(Text),
  proxyUrl: Text,
  caFile: Text,
  caBundleFile: Text
})
export type KeyEnvironment = typeof KeyEnvironmentSchema.Type

const Offset = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const FoundSchema = Schema.Struct({ ranges: Schema.Array(Schema.Tuple([Offset, Offset])) })

const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }
const decodeList = Schema.decodeUnknownSync(VaultListSchema)
const decodeEnvironment = Schema.decodeUnknownSync(KeyEnvironmentSchema)
const decodeFound = Schema.decodeUnknownSync(FoundSchema)

const SCRUB_WINDOW = 65_536
const SCRUB_OVERLAP = 8_192
const SECRET_MARK = "[saved secret]"

const ASKS_PER_WINDOW = 5
const ASK_WINDOW_MS = 5 * 60 * 1_000
const MAX_RUNS_HOLDING_GRANTS = 1_000

class VaultUnavailableError extends Error {
  constructor() {
    super("The Vault needs the Arden app, and this server runs without it.")
    this.name = "VaultUnavailableError"
  }
}

export interface VaultKeysService {
  readonly list: () => Promise<VaultList>
  readonly grant: (runId: string, keyId: string) => void
  readonly granted: (runId: string) => ReadonlyArray<string>
  readonly environment: (runId: string, reach: KeyProxyReach) => Promise<KeyEnvironment | undefined>
  readonly redact: (text: string) => Promise<string>
  readonly end: (runId: string) => Promise<void>
  readonly takeAsk: (sessionId: string, toolCallId: string) => boolean
}

export class VaultKeys extends Context.Service<VaultKeys, VaultKeysService>()(
  "@arden-hq/server/credentials/VaultKeys"
) {
  static readonly layer = (
    broker: VaultKeyBroker | undefined,
    options: { readonly now?: () => number } = {}
  ): Layer.Layer<VaultKeys> => Layer.succeed(VaultKeys, makeVaultKeys(broker, options))
}

export const makeVaultKeys = (
  broker: VaultKeyBroker | undefined,
  { now = Date.now }: { readonly now?: () => number } = {}
): VaultKeysService => {
  const grants = new Map<string, Array<string>>()
  const asks = new Map<string, Array<{ readonly at: number; readonly call: string }>>()
  const requireBroker = (): VaultKeyBroker => {
    if (broker === undefined) throw new VaultUnavailableError()
    return broker
  }
  const granted = (runId: string): ReadonlyArray<string> => grants.get(runId) ?? []
  return {
    list: async () => decodeList(await requireBroker().listVault(), strict),
    grant: (runId, keyId) => {
      const held = grants.get(runId) ?? []
      grants.delete(runId)
      grants.set(runId, held.includes(keyId) ? held : [...held, keyId])
      const oldest = grants.keys().next().value
      if (grants.size > MAX_RUNS_HOLDING_GRANTS && oldest !== undefined) grants.delete(oldest)
    },
    granted,
    environment: async (runId, reach) => {
      const ids = granted(runId)
      if (ids.length === 0) return undefined
      const listed = decodeList(await requireBroker().listVault(), strict)
      const saved = ids.filter((id) => listed.keys.some((key) => key.id === id))
      if (saved.length === 0) return undefined
      return decodeEnvironment(
        await requireBroker().keyEnvironment({ runId, ids: saved, reach }),
        strict
      )
    },
    redact: async (text) => {
      if (broker === undefined || text.length === 0) return text
      const ranges: Array<readonly [number, number]> = []
      for (let start = 0; start < text.length; start += SCRUB_WINDOW - SCRUB_OVERLAP) {
        const window = text.slice(start, start + SCRUB_WINDOW)
        const found = decodeFound(await broker.findSecrets(window), strict)
        for (const [from, to] of found.ranges)
          if (from < to && to <= window.length) ranges.push([start + from, start + to])
        if (start + SCRUB_WINDOW >= text.length) break
      }
      return replaceRanges(text, ranges)
    },
    end: async (runId) => {
      const had = granted(runId).length > 0
      grants.delete(runId)
      if (broker === undefined || !had) return
      await broker.endKeySession(runId).catch(() => undefined)
    },
    takeAsk: (sessionId, toolCallId) => {
      const at = now()
      const recent = (asks.get(sessionId) ?? []).filter((ask) => at - ask.at < ASK_WINDOW_MS)
      if (recent.some((ask) => ask.call === toolCallId)) return true
      if (recent.length >= ASKS_PER_WINDOW) {
        asks.set(sessionId, recent)
        return false
      }
      asks.set(sessionId, [...recent, { at, call: toolCallId }])
      return true
    }
  }
}

const replaceRanges = (text: string, ranges: ReadonlyArray<readonly [number, number]>): string => {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0])
  const merged: Array<[number, number]> = []
  for (const [from, to] of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }
  let out = ""
  let at = 0
  for (const [from, to] of merged) {
    out += `${text.slice(at, from)}${SECRET_MARK}`
    at = to
  }
  return `${out}${text.slice(at)}`
}

export const keyVariables = (environment: KeyEnvironment): Readonly<Record<string, string>> => ({
  ...environment.variables,
  HTTPS_PROXY: environment.proxyUrl,
  https_proxy: environment.proxyUrl,
  HTTP_PROXY: environment.proxyUrl,
  http_proxy: environment.proxyUrl,
  NO_PROXY: "",
  no_proxy: "",
  // https://nodejs.org/api/cli.html#node_use_env_proxy1
  NODE_USE_ENV_PROXY: "1",
  NODE_EXTRA_CA_CERTS: environment.caFile,
  SSL_CERT_FILE: environment.caBundleFile,
  CURL_CA_BUNDLE: environment.caBundleFile,
  REQUESTS_CA_BUNDLE: environment.caBundleFile,
  GIT_SSL_CAINFO: environment.caBundleFile
})

export const looksLikeSecret = (text: string): boolean =>
  SECRET_PATTERNS.some((pattern) => pattern.test(text)) ||
  (text.match(/[A-Za-z0-9_\-+/=]{24,}/g) ?? []).some(randomToken)

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i
]

const randomToken = (token: string): boolean => {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(token)).length
  if (classes < 2 || !/[0-9]/.test(token)) return false
  const counts = new Map<string, number>()
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1)
  const entropy = [...counts.values()].reduce((bits, count) => {
    const share = count / token.length
    return bits - share * Math.log2(share)
  }, 0)
  return entropy >= 3.5
}
