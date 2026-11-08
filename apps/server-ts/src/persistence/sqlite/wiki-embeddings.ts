import { Effect, Schema } from "effect"

import {
  mismatchedChunk,
  WikiEmbeddingPageWriteSchema,
  WikiEmbeddingStore,
  WikiEmbeddingStoreError,
  type StoredWikiEmbeddingChunk,
  type WikiEmbeddingIndexRecord,
  type WikiEmbeddingPageState,
  type WikiEmbeddingPageWrite
} from "../memory/embedding-store.js"
import type { PersistenceDeps } from "./deps.js"

const error = (
  operation: WikiEmbeddingStoreError["operation"],
  message: string,
  input?: { readonly pageId?: string; readonly cause?: unknown }
) =>
  new WikiEmbeddingStoreError({
    operation,
    message,
    ...(input?.pageId === undefined ? {} : { pageId: input.pageId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause })
  })

const IndexRowSchema = Schema.Struct({
  index_version: Schema.NonEmptyString,
  model_id: Schema.NonEmptyString,
  dimensions: Schema.Int.check(Schema.isGreaterThan(0)),
  role: Schema.Literals(["serving", "building"] as const),
  started_at: Schema.NonEmptyString
})

const PageRowSchema = Schema.Struct({
  page_id: Schema.NonEmptyString,
  page_version: Schema.NonEmptyString
})

const ChunkRowSchema = Schema.Struct({
  ...PageRowSchema.fields,
  chunk_index: Schema.Natural,
  chunk_text: Schema.NonEmptyString,
  embedding: Schema.Uint8Array
})

const SizeRowSchema = Schema.Struct({
  index_version: Schema.NonEmptyString,
  bytes: Schema.Natural
})

const IndexInputSchema = Schema.Struct({
  indexVersion: Schema.NonEmptyString,
  modelId: Schema.NonEmptyString,
  dimensions: Schema.Int.check(Schema.isGreaterThan(0)),
  startedAt: Schema.NonEmptyString
})

export const makeWikiEmbeddingStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): WikiEmbeddingStore["Service"] => {
  const sql = writer.sql

  const readIndexes = Effect.fn("SqliteWikiEmbeddingStore.readIndexes")(function* (
    operation: WikiEmbeddingStoreError["operation"]
  ) {
    const rows = yield* sql`
      SELECT index_version, model_id, dimensions, role, started_at
      FROM search.wiki_embedding_indexes
      ORDER BY role DESC
    `.pipe(
      Effect.mapError((cause) =>
        error(operation, "Could not read Wiki embedding indexes", { cause })
      )
    )
    const valid = yield* Schema.decodeUnknownEffect(Schema.Array(IndexRowSchema))(rows).pipe(
      Effect.mapError((cause) =>
        error(operation, "Stored Wiki embedding indexes are corrupt", { cause })
      )
    )
    return valid.map((row): WikiEmbeddingIndexRecord => ({
      indexVersion: row.index_version,
      modelId: row.model_id,
      dimensions: row.dimensions,
      role: row.role,
      startedAt: row.started_at
    }))
  })

  const indexes = () => readIndexes("indexes")

  const sizes = Effect.fn("SqliteWikiEmbeddingStore.sizes")(function* () {
    const rows = yield* sql`
      SELECT index_version, SUM(length(embedding) + length(CAST(chunk_text AS BLOB))) AS bytes
      FROM search.wiki_embedding_chunks
      GROUP BY index_version
    `.pipe(
      Effect.mapError((cause) =>
        error("sizes", "Could not measure Wiki embedding indexes", { cause })
      )
    )
    const valid = yield* Schema.decodeUnknownEffect(Schema.Array(SizeRowSchema))(rows).pipe(
      Effect.mapError((cause) =>
        error("sizes", "Stored Wiki embedding sizes are corrupt", { cause })
      )
    )
    return new Map(valid.map((row) => [row.index_version, row.bytes] as const))
  })

  const openBuilding = Effect.fn("SqliteWikiEmbeddingStore.openBuilding")(function* (
    input: Omit<WikiEmbeddingIndexRecord, "role">
  ) {
    const valid = yield* Schema.decodeUnknownEffect(IndexInputSchema)(input).pipe(
      Effect.mapError((cause) => error("open", "Invalid Wiki embedding index", { cause }))
    )
    yield* writer
      .transact(
        Effect.gen(function* () {
          yield* sql`DELETE FROM search.wiki_embedding_indexes WHERE role = 'building'`
          yield* sql`
            INSERT INTO search.wiki_embedding_indexes
              (index_version, model_id, dimensions, role, started_at)
            VALUES (${valid.indexVersion}, ${valid.modelId}, ${valid.dimensions}, 'building',
              ${valid.startedAt})
          `
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          error("open", "Could not open a Wiki embedding index", { cause })
        )
      )
  })

  const promote = Effect.fn("SqliteWikiEmbeddingStore.promote")(function* (indexVersion: string) {
    yield* writer
      .transact(
        Effect.gen(function* () {
          const building = yield* sql<{ readonly index_version: string }>`
            SELECT index_version FROM search.wiki_embedding_indexes
            WHERE index_version = ${indexVersion} AND role = 'building'
          `
          if (building.length === 0)
            return yield* error("promote", "The Wiki embedding index is not being built")
          yield* sql`DELETE FROM search.wiki_embedding_indexes WHERE role = 'serving'`
          yield* sql`
            UPDATE search.wiki_embedding_indexes SET role = 'serving'
            WHERE index_version = ${indexVersion}
          `
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof WikiEmbeddingStoreError
            ? cause
            : error("promote", "Could not switch the Wiki embedding index", { cause })
        )
      )
  })

  const drop = Effect.fn("SqliteWikiEmbeddingStore.drop")(function* (indexVersion: string) {
    yield* writer
      .run(sql`DELETE FROM search.wiki_embedding_indexes WHERE index_version = ${indexVersion}`)
      .pipe(
        Effect.mapError((cause) =>
          error("drop", "Could not delete a Wiki embedding index", { cause })
        )
      )
  })

  const pages = Effect.fn("SqliteWikiEmbeddingStore.pages")(function* (indexVersion: string) {
    const rows = yield* sql`
      SELECT page_id, page_version FROM search.wiki_embedding_pages
      WHERE index_version = ${indexVersion}
      ORDER BY page_id
    `.pipe(
      Effect.mapError((cause) => error("pages", "Could not read Wiki embedding state", { cause }))
    )
    const valid = yield* Schema.decodeUnknownEffect(Schema.Array(PageRowSchema))(rows).pipe(
      Effect.mapError((cause) =>
        error("pages", "Stored Wiki embedding state is corrupt", { cause })
      )
    )
    return valid.map((row): WikiEmbeddingPageState => ({
      pageId: row.page_id,
      pageVersion: row.page_version
    }))
  })

  const replacePage = Effect.fn("SqliteWikiEmbeddingStore.replacePage")(function* (
    input: WikiEmbeddingPageWrite
  ) {
    const valid = yield* Schema.decodeUnknownEffect(WikiEmbeddingPageWriteSchema)(input).pipe(
      Effect.mapError((cause) =>
        error("replace", "Invalid Wiki embedding page", { pageId: input.pageId, cause })
      )
    )
    const index = (yield* readIndexes("replace")).find(
      (candidate) => candidate.indexVersion === valid.indexVersion
    )
    if (index === undefined)
      return yield* error("replace", "The Wiki embedding index does not exist", {
        pageId: valid.pageId
      })
    const mismatch = mismatchedChunk(valid, index.dimensions)
    if (mismatch !== undefined)
      return yield* error(
        "replace",
        `Chunk ${String(mismatch)} does not have ${String(index.dimensions)} dimensions`,
        { pageId: valid.pageId }
      )
    yield* writer
      .transact(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM search.wiki_embedding_pages
            WHERE index_version = ${valid.indexVersion} AND page_id = ${valid.pageId}
          `
          yield* sql`
            INSERT INTO search.wiki_embedding_pages (index_version, page_id, page_version)
            VALUES (${valid.indexVersion}, ${valid.pageId}, ${valid.pageVersion})
          `
          yield* Effect.forEach(
            valid.chunks,
            (chunk) => sql`
              INSERT INTO search.wiki_embedding_chunks
                (index_version, page_id, chunk_index, chunk_text, embedding)
              VALUES (${valid.indexVersion}, ${valid.pageId}, ${chunk.chunkIndex},
                ${chunk.chunkText}, ${chunk.embedding})
            `,
            { discard: true }
          )
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          error("replace", "Could not replace Wiki embeddings", { pageId: valid.pageId, cause })
        )
      )
  })

  const deletePages = Effect.fn("SqliteWikiEmbeddingStore.deletePages")(function* (
    indexVersion: string,
    pageIds: ReadonlyArray<string>
  ) {
    if (pageIds.length === 0) return
    yield* writer
      .transact(
        Effect.forEach(
          [...new Set(pageIds)],
          (pageId) => sql`
            DELETE FROM search.wiki_embedding_pages
            WHERE index_version = ${indexVersion} AND page_id = ${pageId}
          `,
          { discard: true }
        )
      )
      .pipe(
        Effect.mapError((cause) =>
          error("delete", "Could not delete stale Wiki embeddings", { cause })
        )
      )
  })

  const list = Effect.fn("SqliteWikiEmbeddingStore.list")(function* (indexVersion: string) {
    const rows = yield* sql`
      SELECT chunk.page_id, page.page_version, chunk.chunk_index, chunk.chunk_text, chunk.embedding
      FROM search.wiki_embedding_chunks AS chunk
      JOIN search.wiki_embedding_pages AS page
        ON page.index_version = chunk.index_version AND page.page_id = chunk.page_id
      WHERE chunk.index_version = ${indexVersion}
      ORDER BY chunk.page_id, chunk.chunk_index
    `.pipe(Effect.mapError((cause) => error("list", "Could not read Wiki embeddings", { cause })))
    const valid = yield* Schema.decodeUnknownEffect(Schema.Array(ChunkRowSchema))(rows).pipe(
      Effect.mapError((cause) => error("list", "Stored Wiki embeddings are corrupt", { cause }))
    )
    return valid.map((row): StoredWikiEmbeddingChunk => ({
      pageId: row.page_id,
      pageVersion: row.page_version,
      chunkIndex: row.chunk_index,
      chunkText: row.chunk_text,
      embedding: Uint8Array.from(row.embedding)
    }))
  })

  return WikiEmbeddingStore.of({
    indexes,
    sizes,
    openBuilding,
    promote,
    drop,
    pages,
    replacePage,
    deletePages,
    list
  })
}
