import {
  RESOURCE_STATE,
  type ManagedFileRepositoryShape,
  type RevisionError
} from "@arden-hq/revisions/effect"
import { markdownWords } from "@arden-hq/protocol/chat"
import { countOf } from "@arden-hq/std/count"
import { Effect, Option, Schema } from "effect"

import { parseWikiPage } from "./page.js"
import { FORGOTTEN_PAGE_PATH } from "./code-owned-pages.js"

export const MIN_CLAIM_WORDS = 4

export const MAX_CLAIM_CHARS = 300

const Said = Schema.Struct({
  chat: Schema.String,
  at: Schema.String
})

const RetractionFields = {
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  said: Said,
  claim: Schema.String,
  removed: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.String }))
}

export const RETRACTION_STATUS = { open: "open", closed: "closed" } as const

const OpenRetraction = Schema.Struct({
  ...RetractionFields,
  status: Schema.Literal(RETRACTION_STATUS.open)
})

const ClosedRetraction = Schema.Struct({
  ...RetractionFields,
  status: Schema.Literal(RETRACTION_STATUS.closed),
  closed: Said
})

export const Retraction = Schema.Union([OpenRetraction, ClosedRetraction])
export type Retraction = typeof Retraction.Type
export type OpenRetraction = typeof OpenRetraction.Type

export const RETRACTIONS_KEY = "retractions"

const decodeRetraction = Schema.decodeUnknownOption(Retraction)

export const readRetraction = (value: Schema.Json): Retraction | undefined =>
  Option.getOrUndefined(decodeRetraction(value))

export const storedRetractions = (
  metadata: Readonly<Record<string, Schema.Json>>
): {
  readonly stored: ReadonlyArray<Schema.Json>
  readonly entries: ReadonlyArray<Retraction>
} => {
  const value = metadata[RETRACTIONS_KEY]
  const stored: ReadonlyArray<Schema.Json> = value === undefined ? [] : [value].flat()
  return {
    stored,
    entries: stored.flatMap((entry) => readRetraction(entry) ?? [])
  }
}

const readableRetractions = (
  metadata: Readonly<Record<string, Schema.Json>>
): Effect.Effect<ReadonlyArray<Retraction>> => {
  const { stored, entries } = storedRetractions(metadata)
  const skipped = stored.length - entries.length
  return skipped === 0
    ? Effect.succeed(entries)
    : Effect.logWarning(
        `${FORGOTTEN_PAGE_PATH}: ${countOf(skipped, "entry")} that do not read are not guarded`
      ).pipe(Effect.as(entries))
}

const decoder = new TextDecoder()

export const openRetractions = Effect.fn("Wiki.openRetractions")(function* (
  repository: ManagedFileRepositoryShape
): Effect.fn.Return<ReadonlyArray<OpenRetraction>, RevisionError> {
  const resource = yield* repository.findByPath(FORGOTTEN_PAGE_PATH)
  if (resource === null || resource.state !== RESOURCE_STATE.active) return []
  const page = yield* parseWikiPage(decoder.decode(yield* repository.readVersion(resource))).pipe(
    Effect.option
  )
  if (Option.isNone(page)) {
    yield* Effect.logWarning(`${FORGOTTEN_PAGE_PATH} does not read; no line is guarded`)
    return []
  }
  return (yield* readableRetractions(page.value.metadata)).filter(
    (entry): entry is OpenRetraction => entry.status === RETRACTION_STATUS.open
  )
})

const words = new Intl.Segmenter("und", { granularity: "word" })

const readerWords = (line: string): ReadonlyArray<string> =>
  [...words.segment(markdownWords(line).toLowerCase())].flatMap((segment) =>
    segment.isWordLike === true ? [segment.segment] : []
  )

const compareForm = (readWords: ReadonlyArray<string>): string | undefined =>
  readWords.length >= MIN_CLAIM_WORDS ? readWords.join(" ") : undefined

export const claimKey = (line: string): string | undefined => compareForm(readerWords(line))

const claimKeys = (body: string): ReadonlySet<string> =>
  new Set(body.split("\n").flatMap((line) => claimKey(line) ?? []))

export const guardedLines = (
  open: ReadonlyArray<OpenRetraction>
): ReadonlyMap<string, OpenRetraction> =>
  new Map(
    open.flatMap((entry) =>
      entry.removed.flatMap(({ line }) => {
        const key = claimKey(line)
        return key === undefined ? [] : [[key, entry] as const]
      })
    )
  )

export const putBack = (
  guarded: ReadonlyMap<string, OpenRetraction>,
  before: string | undefined,
  after: string
): OpenRetraction | undefined => {
  if (guarded.size === 0) return undefined
  const had = before === undefined ? new Set<string>() : claimKeys(before)
  for (const key of claimKeys(after)) {
    const entry = had.has(key) ? undefined : guarded.get(key)
    if (entry !== undefined) return entry
  }
  return undefined
}

export const retractionRefusal = (path: string, entry: OpenRetraction): string =>
  `${path} would put back a line the owner asked to forget (entry ${entry.id} in ${FORGOTTEN_PAGE_PATH}: ${entry.claim}). ` +
  "Nothing was saved. Leave that line out; only the owner can undo the entry."
