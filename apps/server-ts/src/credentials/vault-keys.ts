import { Context, Layer, Schema } from "effect"

/**
 * The agent's side of the Vault. The keys and passwords live in the desktop's main process;
 * this server asks it, over the credential broker, for names, addresses, user names and fake
 * values only (`VaultKeyBroker`). A key's value never reaches this process.
 */

/** The tool whose card is "Use your Todoist key?"; its "Always allow" saves a `vault_key` rule. */
export const VAULT_USE_KEY_TOOL = "vault_use_key"

/** The approval data a key's card carries: the key it asks about. */
export const VaultKeyApprovalDataSchema = Schema.Struct({
  vault_key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
})

/** Which of this machine's services a command may reach through the key proxy. */
type KeyProxyReach = "all" | "remote"

/** The three Vault operations the desktop answers (`credential-vault-broker.cjs`). */
export interface VaultKeyBroker {
  readonly listVault: () => Promise<unknown>
  readonly keyEnvironment: (request: {
    readonly runId: string
    readonly names: ReadonlyArray<string>
    readonly reach: KeyProxyReach
  }) => Promise<unknown>
  /** Where saved keys and passwords appear in the text: [start, end) ranges, never values. */
  readonly findSecrets: (text: string) => Promise<unknown>
}

const Text = Schema.String.check(Schema.isMaxLength(2_048))

const VaultListSchema = Schema.Struct({
  keys: Schema.Array(Schema.Struct({ name: Text, variable: Text, addresses: Schema.Array(Text) })),
  passwords: Schema.Array(
    Schema.Struct({ site: Text, name: Text, userName: Schema.optionalKey(Text) })
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

const strict = { onExcessProperty: "error" } as const
const decodeList = Schema.decodeUnknownSync(VaultListSchema)
const decodeEnvironment = Schema.decodeUnknownSync(KeyEnvironmentSchema)
const decodeFound = Schema.decodeUnknownSync(FoundSchema)

/**
 * The scrub sends output in windows that fit one broker message (JSON may spend 6 bytes on a
 * character), overlapping by more than the longest saved value, so a secret across a window's
 * edge is still found whole.
 */
const SCRUB_WINDOW = 65_536
const SCRUB_OVERLAP = 8_192
const SECRET_MARK = "[saved secret]"

/** Asks for a key or password the agent may make in one chat in a window: Claude's limit. */
const ASKS_PER_WINDOW = 5
const ASK_WINDOW_MS = 5 * 60 * 1_000
/** The runs whose granted keys are kept; the oldest is forgotten first. */
const MAX_RUNS = 1_000

class VaultUnavailableError extends Error {
  constructor() {
    super("The Vault needs the Arden app, and this server runs without it.")
    this.name = "VaultUnavailableError"
  }
}

export interface VaultKeysService {
  /** Names, kinds, addresses and user names; never a value. */
  readonly list: () => Promise<VaultList>
  /** The run may now use this key in its commands (the user allowed it, or a rule does). */
  readonly grant: (runId: string, name: string) => void
  /** The keys a run may use, in the order they were allowed. */
  readonly granted: (runId: string) => ReadonlyArray<string>
  /** Fake values, proxy and certificate details for a run's keys; undefined when it has none. */
  readonly environment: (runId: string, reach: KeyProxyReach) => Promise<KeyEnvironment | undefined>
  /** Command output with every saved key and password replaced. Throws when it cannot check. */
  readonly redact: (text: string) => Promise<string>
  /**
   * Counts one ask for a secret in a chat, once per tool call; false once the chat asked 5
   * times in 5 minutes.
   */
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
    grant: (runId, name) => {
      const held = grants.get(runId) ?? []
      grants.delete(runId)
      grants.set(runId, held.includes(name) ? held : [...held, name])
      const oldest = grants.keys().next().value
      if (grants.size > MAX_RUNS && oldest !== undefined) grants.delete(oldest)
    },
    granted,
    environment: async (runId, reach) => {
      const names = granted(runId)
      if (names.length === 0) return undefined
      return decodeEnvironment(
        await requireBroker().keyEnvironment({ runId, names, reach }),
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

/** The text with each range (merged where they overlap) replaced by SECRET_MARK. */
export const replaceRanges = (
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>
): string => {
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

/** The environment variables a command gets for its run's keys, beside its own. */
export const keyVariables = (environment: KeyEnvironment): Readonly<Record<string, string>> => ({
  ...environment.variables,
  HTTPS_PROXY: environment.proxyUrl,
  https_proxy: environment.proxyUrl,
  HTTP_PROXY: environment.proxyUrl,
  http_proxy: environment.proxyUrl,
  // Every request goes through the proxy, local ones included: it lets through what a key does
  // not cover, untouched, and a local address on a key's list gets the key.
  NO_PROXY: "",
  no_proxy: "",
  // Node 24 reads the proxy variables only when asked to.
  NODE_USE_ENV_PROXY: "1",
  NODE_EXTRA_CA_CERTS: environment.caFile,
  SSL_CERT_FILE: environment.caBundleFile,
  CURL_CA_BUNDLE: environment.caBundleFile,
  REQUESTS_CA_BUNDLE: environment.caBundleFile,
  GIT_SSL_CAINFO: environment.caBundleFile
})

/**
 * Whether text the agent wrote (a reason on a card) looks like a secret: a known key prefix, a
 * pasted credential pair, or a long random token. A card never carries one.
 */
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
