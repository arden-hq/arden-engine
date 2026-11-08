import type { ToolDeclaration, ToolMeta, ToolSearch } from "../contracts/tools.js"

/** One deferred tool as search sees it. */
export interface ToolSearchDocument {
  readonly declaration: ToolDeclaration
  readonly meta: ToolMeta
}

/**
 * Returns ordered candidates for one query. Search filters catalog membership,
 * deduplicates, and enforces the primary-match limit before adding companions.
 */
export interface ToolSearchStrategy {
  readonly rank: (input: {
    readonly query: string
    readonly limit: number
    readonly catalog: ReadonlyArray<ToolSearchDocument>
  }) => ReadonlyArray<string>
}

const DEFAULT_TOOL_SEARCH_LIMIT = 8
const MAX_TOOL_SEARCH_LIMIT = 20
const LISTING_BUDGET = 6_000

/**
 * Build the search for one model request. The catalog is the request's
 * deferred tools; `loaded` names the ones already in the conversation.
 */
export const makeToolSearch = (options: {
  readonly catalog: ReadonlyArray<ToolSearchDocument>
  readonly loaded: ReadonlySet<string>
  readonly strategy?: ToolSearchStrategy
}): ToolSearch => {
  const strategy = options.strategy ?? defaultToolSearchStrategy
  const byName = new Map(options.catalog.map((document) => [document.declaration.name, document]))
  return {
    description: searchDescription(options.catalog),
    parameters: SEARCH_PARAMETERS,
    lookup: (names) =>
      names.flatMap((name) => {
        const document = byName.get(name)
        return document === undefined ? [] : [withInputHints(document)]
      }),
    search: ({ query, limit }) => {
      const bounded = Math.min(
        Math.max(1, Math.trunc(limit ?? DEFAULT_TOOL_SEARCH_LIMIT)),
        MAX_TOOL_SEARCH_LIMIT
      )
      const matched = [
        ...new Set(strategy.rank({ query, limit: bounded, catalog: options.catalog }))
      ]
        .filter((name) => byName.has(name))
        .slice(0, bounded)
      const companions = matched
        .flatMap((name) => byName.get(name)?.meta.input_sources ?? [])
        .flatMap((source) => source.tools)
        .filter((name) => byName.has(name) && !matched.includes(name) && !options.loaded.has(name))
      return {
        matched,
        tools: [...matched, ...new Set(companions)].flatMap((name) => {
          const document = byName.get(name)
          return document === undefined ? [] : [withInputHints(document)]
        })
      }
    }
  }
}

const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Capability keywords, a group name to browse, group plus capability to target it, or `select:name1,name2` for exact names in order. All obey the primary-match limit."
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TOOL_SEARCH_LIMIT,
      description: `Maximum primary matches (default ${DEFAULT_TOOL_SEARCH_LIMIT}, max ${MAX_TOOL_SEARCH_LIMIT}); required input tools may load in addition.`
    }
  },
  required: ["query"],
  additionalProperties: false
} as const

const withInputHints = (document: ToolSearchDocument): ToolDeclaration => {
  const sources = document.meta.input_sources ?? []
  if (sources.length === 0) return document.declaration
  const lines = sources.map((source) => `- ${source.input}: from ${source.tools.join(" or ")}.`)
  return {
    ...document.declaration,
    description: `${document.declaration.description}\n\nWhere required inputs come from:\n${lines.join("\n")}`
  }
}

const searchDescription = (catalog: ReadonlyArray<ToolSearchDocument>): string =>
  [
    "Load deferred tools before you call them. Loaded tools stay available for the rest of this conversation.",
    "Search with capability keywords, a group name to browse, group plus capability to prefer matching tools in that group, or `select:name1,name2` for exact names in order.",
    "The primary-match limit applies to every search (default 8, maximum 20); batch larger exact selections. Required input tools may load in addition.",
    "Search whenever the request needs a capability from the listing below; do not ask whether to load it.",
    "Tools already in your tool list are callable directly; never search for them.",
    "",
    "Deferred tools by group:",
    catalogListing(catalog)
  ].join("\n")

const catalogListing = (catalog: ReadonlyArray<ToolSearchDocument>): string => {
  const groups = new Map<string, Array<string>>()
  for (const document of catalog) {
    const group = document.meta.group ?? "other"
    const names = groups.get(group) ?? []
    names.push(document.declaration.name)
    groups.set(group, names)
  }
  const lines = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, names]) => `- ${group}: ${[...names].sort().join(", ")}`)
  const full = lines.join("\n")
  if (full.length <= LISTING_BUDGET) return full
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, names]) => `- ${group}: ${names.length} tools`)
    .join("\n")
}

const SELECT_PREFIX = "select:"
const STOP_WORDS = new Set(["a", "an", "and", "for", "of", "or", "the", "to", "tool", "tools"])
const BM25_K1 = 1.2
const BM25_B = 0.75
const NAME_WEIGHT = 3
const COVERAGE_QUERY_WORDS = 4

/**
 * Exact tool names precede residual BM25 hits, preferring hits in named groups;
 * remaining group members follow in name order. `select:a,b` preserves exact
 * selection order. BM25 covers names, groups, descriptions and parameter text.
 * A BM25 result must contain the query's rarest known word,
 * and a long query must also match half its words, so one common word cannot
 * flood the result.
 */
export const defaultToolSearchStrategy: ToolSearchStrategy = {
  rank: ({ query, catalog }) => {
    const trimmed = query.trim()
    if (trimmed.toLowerCase().startsWith(SELECT_PREFIX)) {
      return trimmed
        .slice(SELECT_PREFIX.length)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    }
    const normalized = trimmed.toLowerCase()
    const words = normalized.split(/[\s,;]+/).filter((word) => word.length > 0)
    const requested = words.map((word) => {
      const exact = catalog.find((document) => document.declaration.name.toLowerCase() === word)
      if (exact !== undefined) return { word, exact: [exact.declaration.name], group: [] }
      return {
        word,
        exact: [],
        group: catalog
          .filter((document) => document.meta.group?.toLowerCase() === word)
          .map((document) => document.declaration.name)
          .sort()
      }
    })
    const exact = requested.flatMap((request) => request.exact)
    const group = requested.flatMap((request) => request.group)
    const groupNames = new Set(group)
    const rest = requested
      .filter((request) => request.exact.length === 0 && request.group.length === 0)
      .map((request) => request.word)
    const ranked = rest.length === 0 ? [] : rankBm25({ query: rest.join(" "), catalog })
    return [
      ...exact,
      ...ranked.filter((name) => groupNames.has(name)),
      ...ranked.filter((name) => !groupNames.has(name)),
      ...group
    ]
  }
}

const rankBm25 = (input: {
  readonly query: string
  readonly catalog: ReadonlyArray<ToolSearchDocument>
}): ReadonlyArray<string> => {
  const documents = input.catalog.map((document) => ({
    name: document.declaration.name,
    terms: documentTerms(document)
  }))
  const frequency = new Map<string, number>()
  for (const document of documents) {
    for (const term of new Set(document.terms)) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  }
  const queryTerms = [...new Set(tokenize(input.query))].filter((term) => frequency.has(term))
  if (queryTerms.length === 0) return []
  const rarest = queryTerms.reduce((best, term) =>
    (frequency.get(term) ?? 0) < (frequency.get(best) ?? 0) ? term : best
  )
  const required = queryTerms.length >= COVERAGE_QUERY_WORDS ? Math.ceil(queryTerms.length / 2) : 1
  const averageLength =
    documents.reduce((sum, document) => sum + document.terms.length, 0) /
    Math.max(1, documents.length)
  return documents
    .flatMap((document) => {
      const counts = new Map<string, number>()
      for (const term of document.terms) counts.set(term, (counts.get(term) ?? 0) + 1)
      const present = queryTerms.filter((term) => counts.has(term))
      if (!counts.has(rarest) || present.length < required) return []
      const score = present.reduce((sum, term) => {
        const count = counts.get(term) ?? 0
        const documentFrequency = frequency.get(term) ?? 0
        const idf = Math.log(
          1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5)
        )
        const norm = BM25_K1 * (1 - BM25_B + (BM25_B * document.terms.length) / averageLength)
        return sum + (idf * count * (BM25_K1 + 1)) / (count + norm)
      }, 0)
      return [{ name: document.name, score }]
    })
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .map((document) => document.name)
}

const documentTerms = (document: ToolSearchDocument): ReadonlyArray<string> => {
  const named = tokenize(`${document.declaration.name} ${document.meta.group ?? ""}`)
  return [
    ...Array.from({ length: NAME_WEIGHT }, () => named).flat(),
    ...tokenize(document.declaration.description),
    ...tokenize(schemaText(document.declaration.parameters))
  ]
}

const schemaText = (schema: unknown): string => {
  if (typeof schema !== "object" || schema === null) return ""
  if (Array.isArray(schema)) return schema.map(schemaText).join(" ")
  return Object.entries(schema)
    .map(([key, value]) => {
      if (key === "description" && typeof value === "string") return value
      if (key === "properties" && typeof value === "object" && value !== null) {
        return Object.entries(value)
          .map(([property, nested]) => `${property} ${schemaText(nested)}`)
          .join(" ")
      }
      return typeof value === "object" ? schemaText(value) : ""
    })
    .join(" ")
}

const tokenize = (text: string): ReadonlyArray<string> =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem)

const stem = (word: string): string => {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3)
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}
