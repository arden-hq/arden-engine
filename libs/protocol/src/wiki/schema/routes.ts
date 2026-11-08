import { nonRelativePathSegment } from "../../common/routes.js"
import { Effect, Schema } from "effect"
import { NonNegativeIntSchema, PositiveIntSchema } from "../../common/schema.js"
import { strict, trimmedText, WikiPageIdSchema, WikiRevisionIdSchema } from "./shared.js"
import { WIKI_PAGE_MAX_LIMIT } from "../contracts.js"

export const WikiPageListOptionsSchema = Schema.Struct({
  includeRedirects: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(
    PositiveIntSchema.check(Schema.isLessThanOrEqualTo(WIKI_PAGE_MAX_LIMIT))
  ),
  cursor: Schema.optionalKey(trimmedText(1_024))
})

export const WikiHistoryRouteOptionsSchema = Schema.Struct({
  limit: Schema.optionalKey(PositiveIntSchema.check(Schema.isLessThanOrEqualTo(200)))
})

export const WikiDiffRouteOptionsSchema = Schema.Struct({
  base: Schema.optionalKey(Schema.NullOr(WikiRevisionIdSchema)),
  target: Schema.optionalKey(Schema.NullOr(WikiRevisionIdSchema)),
  offset: Schema.optionalKey(NonNegativeIntSchema),
  limit: Schema.optionalKey(PositiveIntSchema.check(Schema.isLessThanOrEqualTo(65_536))),
  tail: Schema.optionalKey(Schema.Boolean)
}).check(
  Schema.makeFilter((options) =>
    options.tail === true && (options.offset ?? 0) !== 0
      ? { path: ["offset"], issue: "must be zero when tail is requested" }
      : undefined
  )
)

/** Two versions of one page, as a write's receipt names them: `before` is
 *  "absent" for a page the write created. Its own HTTP query codec: both are
 *  plain strings. */
export const WikiVersionDiffRouteOptionsSchema = Schema.Struct({
  before: WikiRevisionIdSchema,
  after: WikiRevisionIdSchema
})

export const WikiRenameDecisionSchema = Schema.Literals(["accept", "reject"] as const)

/** HTTP query codecs. Plain client options remain camel-case above. */
export const WikiPageListQuerySchema = Schema.Struct({
  include_redirects: Schema.optionalKey(Schema.Literals(["true", "false"] as const)),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WIKI_PAGE_MAX_LIMIT)
    )
  ),
  cursor: Schema.optionalKey(trimmedText(1_024))
})

export const WikiHistoryQuerySchema = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(200)
    )
  )
})

export const WikiDiffQuerySchema = Schema.Struct({
  base: Schema.optionalKey(WikiRevisionIdSchema),
  target: Schema.optionalKey(WikiRevisionIdSchema),
  offset: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  ),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(65_536)
    )
  ),
  tail: Schema.optionalKey(Schema.Literals(["true", "false"] as const))
}).check(
  Schema.makeFilter((query) =>
    query.tail === "true" && (query.offset ?? 0) !== 0
      ? { path: ["offset"], issue: "must be zero when tail is requested" }
      : undefined
  )
)

const encodePagePath = (pageId: string) => `/admin/wiki/pages/${encodeURIComponent(pageId)}`

export const encodeWikiPagesPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(WikiPageListOptionsSchema)(value, strict).pipe(
    Effect.map((options) => {
      const query = new URLSearchParams()
      if (options.includeRedirects === true) query.set("include_redirects", "true")
      if (options.limit !== undefined) query.set("limit", String(options.limit))
      if (options.cursor !== undefined) query.set("cursor", options.cursor)
      const search = query.toString()
      return `/admin/wiki/pages${search === "" ? "" : `?${search}`}`
    })
  )

export const encodeWikiPagePathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(WikiPageIdSchema)(value, strict).pipe(Effect.map(encodePagePath))

export const encodeWikiArchivePathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(WikiPageIdSchema)(value, strict).pipe(
    Effect.map((pageId) => `${encodePagePath(pageId)}/archive`)
  )

export const encodeWikiRestoreArchivedPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(WikiPageIdSchema)(value, strict).pipe(
    Effect.map((pageId) => `${encodePagePath(pageId)}/restore`)
  )

export const encodeWikiHistoryPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      pageId: WikiPageIdSchema,
      options: WikiHistoryRouteOptionsSchema
    })
  )(value, strict).pipe(
    Effect.map(({ pageId, options }) => {
      const path = `${encodePagePath(pageId)}/history`
      return options.limit === undefined ? path : `${path}?limit=${options.limit}`
    })
  )

export const encodeWikiHistoryRestorePathEffect = (value: unknown) =>
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

export const encodeWikiDiffPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      pageId: WikiPageIdSchema,
      options: WikiDiffRouteOptionsSchema
    })
  )(value, strict).pipe(
    Effect.map(({ pageId, options }) => {
      const query = new URLSearchParams()
      if (options.base != null) query.set("base", options.base)
      if (options.target != null) query.set("target", options.target)
      if (options.offset !== undefined) query.set("offset", String(options.offset))
      if (options.limit !== undefined) query.set("limit", String(options.limit))
      if (options.tail === true) query.set("tail", "true")
      const search = query.toString()
      return `${encodePagePath(pageId)}/diff${search === "" ? "" : `?${search}`}`
    })
  )

export const encodeWikiVersionDiffPathEffect = (value: unknown) =>
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

export const encodeWikiLinksPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(WikiPageIdSchema)(value, strict).pipe(
    Effect.map((pageId) => `${encodePagePath(pageId)}/links`)
  )

export const encodeWikiRenameDecisionPathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      approvalId: trimmedText(512).check(nonRelativePathSegment),
      decision: WikiRenameDecisionSchema
    })
  )(value, strict).pipe(
    Effect.map(
      ({ approvalId, decision }) =>
        `/admin/wiki/rename-approvals/${encodeURIComponent(approvalId)}/${decision}`
    )
  )
