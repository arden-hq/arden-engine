import { Effect, Schema } from "effect"

import {
  aliasesSchema,
  strict,
  WikiPageIdSchema,
  WikiPathSchema,
  WikiRevisionIdSchema,
  WikiTitleSchema,
  WikiMetadataSchema
} from "./shared.js"

export const CreateWikiPageInputSchema = Schema.Struct({
  path: WikiPathSchema,
  title: WikiTitleSchema,
  body: Schema.optionalKey(Schema.String),
  pageId: Schema.optionalKey(WikiPageIdSchema),
  aliases: Schema.optionalKey(aliasesSchema),
  metadata: Schema.optionalKey(WikiMetadataSchema)
})

export const RenameWikiPageInputSchema = Schema.Struct({
  newPath: WikiPathSchema,
  newTitle: WikiTitleSchema
})

export const WikiPageGuardSchema = Schema.Struct({
  pageId: WikiPageIdSchema,
  version: WikiRevisionIdSchema,
  repositoryHead: WikiRevisionIdSchema
})

export const WikiCreateRequestContextSchema = Schema.Struct({
  repositoryHead: Schema.NullOr(WikiRevisionIdSchema),
  input: CreateWikiPageInputSchema
})

export const WikiUpdateRequestContextSchema = Schema.Struct({
  page: WikiPageGuardSchema,
  content: Schema.String
})

export const WikiRenameRequestContextSchema = Schema.Struct({
  page: WikiPageGuardSchema,
  input: RenameWikiPageInputSchema
})

export const WikiRenameRejectInputSchema = Schema.Struct({
  resolution: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))))
})

export const WikiCreateRequestSchema = Schema.Struct({
  path: WikiPathSchema,
  title: WikiTitleSchema,
  body: Schema.String,
  page_id: Schema.optionalKey(WikiPageIdSchema),
  aliases: aliasesSchema,
  metadata: WikiMetadataSchema,
  expected_head: Schema.NullOr(WikiRevisionIdSchema)
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

export const WikiRenameRequestSchema = Schema.Struct({
  page_id: WikiPageIdSchema,
  new_path: WikiPathSchema,
  new_title: WikiTitleSchema,
  expected_version: WikiRevisionIdSchema,
  expected_head: WikiRevisionIdSchema
})

export const WikiRenameRejectRequestSchema = Schema.Struct({
  resolution: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))))
})

/** Encode the public create input into the server's revision-aware request body. */
export const encodeCreateWikiRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(WikiCreateRequestContextSchema)(value, strict).pipe(
    Effect.map(({ repositoryHead, input }) => ({
      path: input.path,
      title: input.title,
      body: input.body ?? "",
      ...(input.pageId === undefined ? {} : { page_id: input.pageId }),
      aliases: input.aliases ?? [],
      metadata: input.metadata ?? {},
      expected_head: repositoryHead
    })),
    Effect.flatMap((request) =>
      Schema.decodeUnknownEffect(WikiCreateRequestSchema)(request, strict)
    ),
    Effect.map(JSON.stringify)
  )

/** Encode a page edit while deriving both optimistic-concurrency guards. */
export const encodeUpdateWikiRequestEffect = (value: unknown) =>
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

export const encodeWikiVersionRequestEffect = (value: unknown) =>
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

export const encodeRenameWikiRequestEffect = (value: unknown) =>
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

export const encodeRejectWikiRenameRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(WikiRenameRejectInputSchema)(value, strict).pipe(
    Effect.flatMap((request) =>
      Schema.decodeUnknownEffect(WikiRenameRejectRequestSchema)(request, strict)
    ),
    Effect.map(JSON.stringify)
  )
