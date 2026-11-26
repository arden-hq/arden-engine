import { Effect, Schema } from "effect"

import {
  strict,
  WikiPageIdSchema,
  WikiPathSchema,
  WikiRestoreSideSchema,
  WikiRevisionIdSchema,
  WikiTitleSchema
} from "./shared.js"

export const RenameWikiPageInputSchema = Schema.Struct({
  newPath: WikiPathSchema,
  newTitle: WikiTitleSchema
})

export const WikiPageGuardSchema = Schema.Struct({
  pageId: WikiPageIdSchema,
  version: WikiRevisionIdSchema,
  repositoryHead: WikiRevisionIdSchema
})

export const WikiUpdateRequestContextSchema = Schema.Struct({
  page: WikiPageGuardSchema,
  content: Schema.String
})

export const WikiHistoryRestoreRequestContextSchema = Schema.Struct({
  page: WikiPageGuardSchema,
  side: WikiRestoreSideSchema
})

export const WikiRenameRequestContextSchema = Schema.Struct({
  page: WikiPageGuardSchema,
  input: RenameWikiPageInputSchema
})

export const WikiUpdateRequestSchema = Schema.Struct({
  content: Schema.String,
  expected_version: WikiRevisionIdSchema,
  expected_head: WikiRevisionIdSchema
})

export const WikiVersionRequestSchema = Schema.Struct({
  expected_version: WikiRevisionIdSchema,
  expected_head: WikiRevisionIdSchema
})

export const WikiHistoryRestoreRequestSchema = Schema.Struct({
  expected_version: WikiRevisionIdSchema,
  expected_head: WikiRevisionIdSchema,
  side: WikiRestoreSideSchema
})

export const WikiRenameRequestSchema = Schema.Struct({
  page_id: WikiPageIdSchema,
  new_path: WikiPathSchema,
  new_title: WikiTitleSchema,
  expected_version: WikiRevisionIdSchema,
  expected_head: WikiRevisionIdSchema
})

/** Encode a page edit while deriving both optimistic-concurrency guards. */
export const encodeUpdateWikiRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(WikiUpdateRequestContextSchema)(value, strict).pipe(
    Effect.map(({ page, content }) => ({
      content,
      expected_version: page.version,
      expected_head: page.repositoryHead
    })),
    Effect.flatMap((request) =>
      Schema.decodeUnknownEffect(WikiUpdateRequestSchema)(request, strict)
    ),
    Effect.map(JSON.stringify)
  )

export const encodeWikiVersionRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(WikiPageGuardSchema)(value, strict).pipe(
    Effect.map((page) => ({
      expected_version: page.version,
      expected_head: page.repositoryHead
    })),
    Effect.flatMap((request) =>
      Schema.decodeUnknownEffect(WikiVersionRequestSchema)(request, strict)
    ),
    Effect.map(JSON.stringify)
  )

export const encodeWikiHistoryRestoreRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(WikiHistoryRestoreRequestContextSchema)(value, strict).pipe(
    Effect.map(({ page, side }) => ({
      expected_version: page.version,
      expected_head: page.repositoryHead,
      side
    })),
    Effect.flatMap((request) =>
      Schema.decodeUnknownEffect(WikiHistoryRestoreRequestSchema)(request, strict)
    ),
    Effect.map(JSON.stringify)
  )

export const encodeRenameWikiRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(WikiRenameRequestContextSchema)(value, strict).pipe(
    Effect.map(({ page, input }) => ({
      page_id: page.pageId,
      new_path: input.newPath,
      new_title: input.newTitle,
      expected_version: page.version,
      expected_head: page.repositoryHead
    })),
    Effect.flatMap((request) =>
      Schema.decodeUnknownEffect(WikiRenameRequestSchema)(request, strict)
    ),
    Effect.map(JSON.stringify)
  )
