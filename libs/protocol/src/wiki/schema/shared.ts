import { nonRelativePathSegment } from "../../common/routes.js"
import { Schema } from "effect"

import { IsoDateTimeStringSchema } from "../../common/schema.js"
import { WIKI_DIFF_BASE, WIKI_EXCERPT, WIKI_MOMENT, WIKI_PAGE_LIFECYCLE } from "../contracts.js"

export const strict = { onExcessProperty: "error" } as const

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
      parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      return "must be a normalized relative Markdown path"
    }
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0
      if (
        code < 32 ||
        code === 127 ||
        character === "[" ||
        character === "]" ||
        character === "|" ||
        character === "#"
      ) {
        return "contains characters reserved by Wiki links"
      }
    }
    if (parts.length > 1 && parts.at(-1)?.toLowerCase() === "readme.md") {
      return "a nested README.md is a directory page"
    }
    return undefined
  })
)
export const WikiTitleSchema = trimmedText(4_096)
export const WikiResourceStateSchema = Schema.Literals(["active", "archived"] as const)
export const WikiRestoreSideSchema = Schema.Literals(["after", "before"] as const)
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
