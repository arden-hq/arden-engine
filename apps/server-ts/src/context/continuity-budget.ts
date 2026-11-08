type ContinuityContextSourceKind = "space_page" | "recall" | "session" | "memory" | "other"

export interface ContinuityContextSource {
  readonly identity: string
  readonly kind: ContinuityContextSourceKind
  readonly content: string
  readonly priority: number
}

interface BudgetedContinuityContextSource extends ContinuityContextSource {
  readonly truncated: boolean
}

interface ContinuityContextTelemetry {
  readonly inputBytes: number
  readonly eligibleBytes: number
  readonly outputBytes: number
  readonly truncatedBytes: number
  readonly inputSources: number
  readonly keptSources: number
  readonly duplicateSources: number
  readonly excludedSources: number
  readonly truncatedSources: number
  readonly keptByKind: Readonly<Record<ContinuityContextSourceKind, number>>
}

export interface BudgetedContinuityContext {
  readonly content: string
  readonly sources: ReadonlyArray<BudgetedContinuityContextSource>
  readonly telemetry: ContinuityContextTelemetry
}

export const LIVE_CONTINUITY_CONTEXT_MAX_BYTES = 16_000

const encoder = new TextEncoder()
const separator = "\n\n"
const separatorBytes = encoder.encode(separator).byteLength

const byteLength = (value: string): number => encoder.encode(value).byteLength

const bytePrefix = (value: string, maximum: number): string => {
  if (maximum <= 0) return ""
  const bytes = encoder.encode(value)
  if (bytes.byteLength <= maximum) return value
  return new TextDecoder().decode(bytes.slice(0, maximum), { stream: true })
}

const emptyKindCounts = (): Record<ContinuityContextSourceKind, number> => ({
  space_page: 0,
  recall: 0,
  session: 0,
  memory: 0,
  other: 0
})

export function budgetContinuityContext(options: {
  readonly sources: ReadonlyArray<ContinuityContextSource>
  readonly maxBytes: number
  readonly excludedIdentities?: ReadonlySet<string>
}): BudgetedContinuityContext {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new TypeError("Continuity context maxBytes must be a non-negative safe integer")
  }

  const excluded = options.excludedIdentities ?? new Set<string>()
  const ranked = new Map<
    string,
    { readonly source: ContinuityContextSource; readonly index: number }
  >()
  let excludedSources = 0
  let duplicateSources = 0
  options.sources.forEach((source, index) => {
    if (excluded.has(source.identity)) {
      excludedSources += 1
      return
    }
    const prior = ranked.get(source.identity)
    if (prior === undefined) {
      ranked.set(source.identity, { source, index })
      return
    }
    duplicateSources += 1
    if (source.priority > prior.source.priority) {
      ranked.set(source.identity, { source, index })
    }
  })

  const eligible = [...ranked.values()].sort(
    (left, right) => right.source.priority - left.source.priority || left.index - right.index
  )
  const kept: Array<BudgetedContinuityContextSource> = []
  let outputBytes = 0
  let truncatedBytes = 0
  let truncatedSources = 0
  for (const entry of eligible) {
    const prefixBytes = kept.length === 0 ? 0 : separatorBytes
    const available = options.maxBytes - outputBytes - prefixBytes
    const sourceBytes = byteLength(entry.source.content)
    if (available <= 0) {
      truncatedBytes += sourceBytes
      truncatedSources += 1
      continue
    }
    const content = bytePrefix(entry.source.content, available)
    const keptBytes = byteLength(content)
    if (keptBytes === 0) {
      truncatedBytes += sourceBytes
      truncatedSources += 1
      continue
    }
    const truncated = keptBytes < sourceBytes
    kept.push({ ...entry.source, content, truncated })
    outputBytes += prefixBytes + keptBytes
    if (truncated) {
      truncatedBytes += sourceBytes - keptBytes
      truncatedSources += 1
    }
  }

  const keptByKind = emptyKindCounts()
  kept.forEach((source) => {
    keptByKind[source.kind] += 1
  })
  return {
    content: kept.map((source) => source.content).join(separator),
    sources: kept,
    telemetry: {
      inputBytes: options.sources.reduce((total, source) => total + byteLength(source.content), 0),
      eligibleBytes: eligible.reduce((total, entry) => total + byteLength(entry.source.content), 0),
      outputBytes,
      truncatedBytes,
      inputSources: options.sources.length,
      keptSources: kept.length,
      duplicateSources,
      excludedSources,
      truncatedSources,
      keptByKind
    }
  }
}
