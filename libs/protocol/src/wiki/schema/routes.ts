import { Effect, Schema } from "effect"
import { strict } from "../../common/boundary.js"
import { NonNegativeIntSchema, PositiveIntSchema } from "../../common/schema.js"
import { QueryBooleanTextSchema } from "../../common/routes.js"
import {
  trimmedText,
  WikiDiffBaseSchema,
  WikiPageIdSchema,
  WikiRevisionIdSchema
} from "./shared.js"
import { WIKI_DIFF_BASE, WIKI_LIST_START, WIKI_PAGE_MAX_LIMIT } from "../contracts.js"

const ListLimitSchema = PositiveIntSchema.check(Schema.isLessThanOrEqualTo(WIKI_PAGE_MAX_LIMIT))
const HistoryLimitSchema = PositiveIntSchema.check(Schema.isLessThanOrEqualTo(200))
const DiffLimitSchema = PositiveIntSchema.check(Schema.isLessThanOrEqualTo(65_536))
const CursorSchema = trimmedText(1_024)

export const WikiPageListOptionsSchema = Schema.Struct({
  includeRedirects: Schema.Boolean,
  limit: ListLimitSchema,
  start: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(WIKI_LIST_START.first) }),
    Schema.Struct({ kind: Schema.Literal(WIKI_LIST_START.after), cursor: CursorSchema })
  ])
})

export const WikiHistoryRouteOptionsSchema = Schema.Struct({ limit: HistoryLimitSchema })

export const WikiDiffRouteOptionsSchema = Schema.Struct({
  base: WikiDiffBaseSchema,
  target: WikiRevisionIdSchema,
  offset: NonNegativeIntSchema,
  limit: DiffLimitSchema
})

export const WikiVersionDiffRouteOptionsSchema = Schema.Struct({
  before: WikiRevisionIdSchema,
  after: WikiRevisionIdSchema
})

const queryInt = (minimum: number, maximum: number) =>
  Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(minimum),
    Schema.isLessThanOrEqualTo(maximum)
  )

const listQueryFields = {
  include_redirects: QueryBooleanTextSchema,
  limit: queryInt(1, WIKI_PAGE_MAX_LIMIT)
} as const

export const WikiPageListQuerySchema = Schema.Union([
  Schema.Struct({ ...listQueryFields, start: Schema.Literal(WIKI_LIST_START.first) }),
  Schema.Struct({
    ...listQueryFields,
    start: Schema.Literal(WIKI_LIST_START.after),
    cursor: CursorSchema
  })
])

export const WikiHistoryQuerySchema = Schema.Struct({ limit: queryInt(1, 200) })

const diffQueryFields = {
  target: WikiRevisionIdSchema,
  offset: queryInt(0, Number.MAX_SAFE_INTEGER),
  limit: queryInt(1, 65_536)
} as const

export const WikiDiffQuerySchema = Schema.Union([
  Schema.Struct({ ...diffQueryFields, from: Schema.Literal(WIKI_DIFF_BASE.empty) }),
  Schema.Struct({
    ...diffQueryFields,
    from: Schema.Literal(WIKI_DIFF_BASE.version),
    base: WikiRevisionIdSchema
  })
])

const encodePagePath = (pageId: string) => `/admin/wiki/pages/${encodeURIComponent(pageId)}`

export const encodeWikiPagesPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(WikiPageListOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams({
        include_redirects: String(options.includeRedirects),
        limit: String(options.limit),
        start: options.start.kind
      })
      if (options.start.kind === WIKI_LIST_START.after) query.set("cursor", options.start.cursor)
      return `/admin/wiki/pages?${query.toString()}`
    })
  )

export const encodeWikiPagePathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(WikiPageIdSchema)(value, strict).pipe(Effect.map(encodePagePath))

export const encodeWikiArchivePathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(WikiPageIdSchema)(value, strict).pipe(
    Effect.map((pageId) => `${encodePagePath(pageId)}/archive`)
  )

export const encodeWikiRestoreArchivedPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(WikiPageIdSchema)(value, strict).pipe(
    Effect.map((pageId) => `${encodePagePath(pageId)}/restore`)
  )

export const encodeWikiHistoryPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      pageId: WikiPageIdSchema,
      options: WikiHistoryRouteOptionsSchema
    })
  )(value, strict).pipe(
    Effect.map(({ pageId, options }) => `${encodePagePath(pageId)}/history?limit=${options.limit}`)
  )

export const encodeWikiHistoryRestorePathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      pageId: WikiPageIdSchema,
      commitId: WikiRevisionIdSchema
    })
  )(value, strict).pipe(
    Effect.map(
      ({ pageId, commitId }) =>
        `${encodePagePath(pageId)}/history/${encodeURIComponent(commitId)}/restore`
    )
  )

export const encodeWikiDiffPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      pageId: WikiPageIdSchema,
      options: WikiDiffRouteOptionsSchema
    })
  )(value, strict).pipe(
    Effect.map(({ pageId, options }) => {
      const query = new URLSearchParams({
        target: options.target,
        offset: String(options.offset),
        limit: String(options.limit),
        from: options.base.kind
      })
      if (options.base.kind === WIKI_DIFF_BASE.version) query.set("base", options.base.version)
      return `${encodePagePath(pageId)}/diff?${query.toString()}`
    })
  )

export const encodeWikiVersionDiffPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      pageId: WikiPageIdSchema,
      options: WikiVersionDiffRouteOptionsSchema
    })
  )(value, strict).pipe(
    Effect.map(({ pageId, options }) => {
      const query = new URLSearchParams({ before: options.before, after: options.after })
      return `${encodePagePath(pageId)}/versions/diff?${query.toString()}`
    })
  )

export const encodeWikiLinksPathEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(WikiPageIdSchema)(value, strict).pipe(
    Effect.map((pageId) => `${encodePagePath(pageId)}/links`)
  )
