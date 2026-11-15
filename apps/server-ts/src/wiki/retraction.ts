import type { ManagedFileRepositoryShape, RevisionError } from "@arden-hq/revisions/effect"
import { Effect, Option, Schema } from "effect"

import { parseWikiPage } from "./page.js"
import { FORGOTTEN_PAGE_PATH } from "./system-pages.js"

/**
 * A line of fewer words carries no claim of its own (a heading, a label, a date), so it is
 * neither forgotten nor guarded.
 */
export const MIN_CLAIM_WORDS = 4

/** A retraction's one-line claim is shown in every refusal it causes. */
export const MAX_CLAIM_CHARS = 300

const Said = Schema.Struct({
  /** The chat link of the owner's turn. */
  chat: Schema.String,
  at: Schema.String
})

const RetractionFields = {
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  said: Said,
  claim: Schema.String,
  removed: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.String }))
}

const OpenRetraction = Schema.Struct({ ...RetractionFields, status: Schema.Literal("open") })

const ClosedRetraction = Schema.Struct({
  ...RetractionFields,
  status: Schema.Literal("closed"),
  /** The owner's turn that closed it. */
  closed: Said
})

export const Retraction = Schema.Union([OpenRetraction, ClosedRetraction])
export type Retraction = typeof Retraction.Type
export type OpenRetraction = typeof OpenRetraction.Type

/** The frontmatter key under which the forgotten page stores its retractions. */
export const RETRACTIONS_KEY = "retractions"

const decodeRetraction = Schema.decodeUnknownOption(Retraction)

export const readRetraction = (value: Schema.Json): Retraction | undefined =>
  Option.getOrUndefined(decodeRetraction(value))

/** What the page's metadata stores, as written, and the entries of it that read. */
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

/**
 * The retractions a page's metadata holds. An entry that does not read is skipped with a
 * warning: only the owner can write such an entry, and owner edits are never refused.
 */
export const retractionsOf = (
  metadata: Readonly<Record<string, Schema.Json>>
): Effect.Effect<ReadonlyArray<Retraction>> => {
  const { stored, entries } = storedRetractions(metadata)
  const skipped = stored.length - entries.length
  return skipped === 0
    ? Effect.succeed(entries)
    : Effect.logWarning(
        `${FORGOTTEN_PAGE_PATH}: ${skipped} entries do not read and are not guarded`
      ).pipe(Effect.as(entries))
}

const decoder = new TextDecoder()

/** The open retractions in Memory now. */
export const openRetractions = Effect.fn("Wiki.openRetractions")(function* (
  repository: ManagedFileRepositoryShape
): Effect.fn.Return<ReadonlyArray<OpenRetraction>, RevisionError> {
  const resource = yield* repository.findByPath(FORGOTTEN_PAGE_PATH)
  if (resource === null || resource.state !== "active") return []
  const page = yield* parseWikiPage(decoder.decode(yield* repository.readVersion(resource))).pipe(
    Effect.option
  )
  if (Option.isNone(page)) {
    yield* Effect.logWarning(`${FORGOTTEN_PAGE_PATH} does not read; no line is guarded`)
    return []
  }
  return (yield* retractionsOf(page.value.metadata)).filter(
    (entry): entry is OpenRetraction => entry.status === "open"
  )
})

const EDGE_MARKS = /^[\s\-*#>]+|[\s\-*#>]+$/gu

/**
 * The form two lines are compared in: link targets dropped for their text, spacing folded,
 * list and heading marks trimmed, lower case. Undefined for a line with no claim.
 */
export const claimKey = (line: string): string | undefined => {
  const key = line
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .replace(EDGE_MARKS, "")
    .toLowerCase()
  return key.split(" ").filter((word) => word !== "").length >= MIN_CLAIM_WORDS ? key : undefined
}

const claimKeys = (body: string): ReadonlySet<string> =>
  new Set(body.split("\n").flatMap((line) => claimKey(line) ?? []))

/** The first open retraction a page change would put a line of back, with that line. */
export const putBack = (
  open: ReadonlyArray<OpenRetraction>,
  before: string | undefined,
  after: string
): { readonly entry: OpenRetraction; readonly line: string } | undefined => {
  const had = before === undefined ? new Set<string>() : claimKeys(before)
  const added = [...claimKeys(after)].filter((key) => !had.has(key))
  for (const entry of open) {
    const removed = entry.removed.find(({ line }) => {
      const key = claimKey(line)
      return key !== undefined && added.includes(key)
    })
    if (removed !== undefined) return { entry, line: removed.line }
  }
  return undefined
}

export const retractionRefusal = (path: string, entry: OpenRetraction): string =>
  `${path} would put back a line the owner asked to forget (entry ${entry.id} in ${FORGOTTEN_PAGE_PATH}: ${entry.claim}). ` +
  "Nothing was saved. Leave that line out; only the owner can undo the entry."
