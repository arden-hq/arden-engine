import { nonRelativePathSegment } from "../../common/routes.js"
import { Schema } from "effect"

import { IsoDateTimeStringSchema, withExtras } from "../../common/schema.js"

export const strict = { onExcessProperty: "error" } as const

export const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

export const trimmedText = (maximum: number) =>
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
export const WikiPageLifecycleSchema = Schema.Literals(["active", "redirect"] as const)
export const WikiMetadataSchema = Schema.Record(Schema.String, Schema.Json)

export const aliasesSchema = Schema.Array(trimmedText(4_096)).check(Schema.isMaxLength(100))
export const nullableRevisionIdSchema = Schema.NullOr(WikiRevisionIdSchema)

export const pageFields = {
  page_id: WikiPageIdSchema,
  path: boundedText(4_096),
  resource_state: WikiResourceStateSchema,
  title: boundedText(4_096),
  excerpt: Schema.NullOr(Schema.String),
  aliases: aliasesSchema,
  lifecycle: WikiPageLifecycleSchema,
  redirect_to: Schema.NullOr(boundedText(4_096)),
  metadata: WikiMetadataSchema,
  version: WikiRevisionIdSchema,
  repository_head: Schema.NullOr(WikiRevisionIdSchema),
  created_at: Schema.NullOr(IsoDateTimeStringSchema),
  updated_at: Schema.NullOr(IsoDateTimeStringSchema)
} as const

/** Visible wikilink fields. Parser offsets and content identities stay server-internal. */
export const WikilinkNodeSchema = withExtras({
  page: Schema.NullOr(Schema.String),
  fragment: Schema.NullOr(Schema.String),
  alias: Schema.NullOr(Schema.String)
})
