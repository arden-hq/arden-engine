import { Context, Effect, Schema } from "effect"

type WikiEmbeddingIndexRole = "serving" | "building"

export interface WikiEmbeddingIndexRecord {
  readonly indexVersion: string
  readonly modelId: string
  readonly dimensions: number
  readonly role: WikiEmbeddingIndexRole
  readonly startedAt: string
}

const WikiEmbeddingChunkWriteSchema = Schema.Struct({
  chunkIndex: Schema.Natural,
  chunkText: Schema.NonEmptyString,
  embedding: Schema.Uint8Array
})

export const WikiEmbeddingPageWriteSchema = Schema.Struct({
  indexVersion: Schema.NonEmptyString,
  pageId: Schema.NonEmptyString,
  pageVersion: Schema.NonEmptyString,
  chunks: Schema.Array(WikiEmbeddingChunkWriteSchema)
})

export type WikiEmbeddingPageWrite = (typeof WikiEmbeddingPageWriteSchema)["Type"]

export const mismatchedChunk = (
  write: WikiEmbeddingPageWrite,
  dimensions: number
): number | undefined =>
  write.chunks.find(
    (chunk) => chunk.embedding.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT
  )?.chunkIndex

export interface WikiEmbeddingPageState {
  readonly pageId: string
  readonly pageVersion: string
}

export interface StoredWikiEmbeddingChunk extends WikiEmbeddingPageState {
  readonly chunkIndex: number
  readonly chunkText: string
  readonly embedding: Uint8Array
}

export class WikiEmbeddingStoreError extends Schema.TaggedError<WikiEmbeddingStoreError>()(
  "WikiEmbeddingStoreError",
  {
    operation: Schema.Literals([
      "indexes",
      "sizes",
      "open",
      "promote",
      "drop",
      "pages",
      "replace",
      "delete",
      "list"
    ] as const),
    message: Schema.String,
    pageId: Schema.optionalKey(Schema.NonEmptyString),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class WikiEmbeddingStore extends Context.Service<
  WikiEmbeddingStore,
  {
    readonly indexes: () => Effect.Effect<
      ReadonlyArray<WikiEmbeddingIndexRecord>,
      WikiEmbeddingStoreError
    >
    readonly sizes: () => Effect.Effect<ReadonlyMap<string, number>, WikiEmbeddingStoreError>
    readonly openBuilding: (
      index: Omit<WikiEmbeddingIndexRecord, "role">
    ) => Effect.Effect<void, WikiEmbeddingStoreError>
    readonly promote: (indexVersion: string) => Effect.Effect<void, WikiEmbeddingStoreError>
    readonly drop: (indexVersion: string) => Effect.Effect<void, WikiEmbeddingStoreError>
    readonly pages: (
      indexVersion: string
    ) => Effect.Effect<ReadonlyArray<WikiEmbeddingPageState>, WikiEmbeddingStoreError>
    readonly replacePage: (
      input: WikiEmbeddingPageWrite
    ) => Effect.Effect<void, WikiEmbeddingStoreError>
    readonly deletePages: (
      indexVersion: string,
      pageIds: ReadonlyArray<string>
    ) => Effect.Effect<void, WikiEmbeddingStoreError>
    readonly list: (
      indexVersion: string
    ) => Effect.Effect<ReadonlyArray<StoredWikiEmbeddingChunk>, WikiEmbeddingStoreError>
  }
>()("@arden-hq/server/persistence/memory/WikiEmbeddingStore") {}
