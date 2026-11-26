import { isRelativePathSegment, nonRelativePathSegment } from "../../common/routes.js"
import { Schema } from "effect"

import { IsoDateTimeStringSchema } from "../../common/schema.js"
import {
  WIKI_DIFF_BASE,
  WIKI_EXCERPT,
  WIKI_MOMENT,
  WIKI_PAGE_LIFECYCLE,
  WIKI_RESOURCE_STATE,
  WIKI_RESTORE_SIDE
} from "../contracts.js"

const WIKI_LINK_RESERVED = { open: "[", close: "]", pipe: "|", heading: "#" } as const
type WikiLinkReserved = (typeof WIKI_LINK_RESERVED)[keyof typeof WIKI_LINK_RESERVED]
const wikiLinkReserved: ReadonlySet<string> = new Set<WikiLinkReserved>(
  Object.values(WIKI_LINK_RESERVED)
)
const isWikiLinkReserved = (character: string): character is WikiLinkReserved =>
  wikiLinkReserved.has(character)
const DIRECTORY_PAGE = "readme.md"

export const boundedText = (maximum: number): Schema.String =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

export const trimmedText = (maximum: number): Schema.Trim =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

export const WikiPageIdSchema = trimmedText(512).check(nonRelativePathSegment)
export const WikiRevisionIdSchema = trimmedText(128).check(nonRelativePathSegment)
export const WikiPathSchema = trimmedText(4_096).check(
  Schema.makeFilter((value) => {
    const parts = value.split("/")
    if (
      !value.endsWith(".md") ||
      value.startsWith("/") ||
      value.includes("\\") ||
      value.includes("\0") ||
      parts.some((part) => part.length === 0 || isRelativePathSegment(part))
    ) {
      return "must be a normalized relative Markdown path"
    }
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0
      if (code < 32 || code === 127 || isWikiLinkReserved(character)) {
        return "contains characters reserved by Wiki links"
      }
    }
    if (parts.length > 1 && parts.at(-1)?.toLowerCase() === DIRECTORY_PAGE) {
      return "a nested README.md is a directory page"
    }
    return undefined
  })
)
export const WikiTitleSchema = trimmedText(4_096)
export const WikiResourceStateSchema = Schema.Literals(Object.values(WIKI_RESOURCE_STATE))
export const WikiRestoreSideSchema = Schema.Literals(Object.values(WIKI_RESTORE_SIDE))
export const WikiMetadataSchema = Schema.Record(Schema.String, Schema.Json)

const aliasesSchema = Schema.Array(trimmedText(4_096)).check(Schema.isMaxLength(100))

export const WikiPageLifecycleSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(WIKI_PAGE_LIFECYCLE.active) }),
  Schema.Struct({ kind: Schema.Literal(WIKI_PAGE_LIFECYCLE.redirect), to: boundedText(4_096) })
])

export const WikiExcerptSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(WIKI_EXCERPT.blank) }),
  Schema.Struct({ kind: Schema.Literal(WIKI_EXCERPT.text), text: Schema.String })
])

export const WikiMomentSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(WIKI_MOMENT.unrecorded) }),
  Schema.Struct({ kind: Schema.Literal(WIKI_MOMENT.at), at: IsoDateTimeStringSchema })
])

export const WikiDiffBaseSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(WIKI_DIFF_BASE.empty) }),
  Schema.Struct({ kind: Schema.Literal(WIKI_DIFF_BASE.version), version: WikiRevisionIdSchema })
])

export const pageFields = {
  page_id: WikiPageIdSchema,
  path: boundedText(4_096),
  resource_state: WikiResourceStateSchema,
  title: boundedText(4_096),
  excerpt: WikiExcerptSchema,
  aliases: aliasesSchema,
  lifecycle: WikiPageLifecycleSchema,
  metadata: WikiMetadataSchema,
  version: WikiRevisionIdSchema,
  repository_head: WikiRevisionIdSchema,
  created: WikiMomentSchema,
  updated: WikiMomentSchema
} as const
