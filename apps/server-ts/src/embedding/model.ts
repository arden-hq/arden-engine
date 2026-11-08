import { Context, type Effect, Schema } from "effect"

export interface EmbeddingDocument {
  readonly title: string
  readonly path: string
  readonly body: string
}

export interface EmbeddingDocumentChunk {
  readonly text: string
  readonly excerpt: string
}

export class EmbeddingModelError extends Schema.TaggedError<EmbeddingModelError>()(
  "EmbeddingModelError",
  {
    operation: Schema.Literals(["load", "chunk", "embed"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class EmbeddingModel extends Context.Service<
  EmbeddingModel,
  {
    readonly modelId: string
    readonly indexVersion: string
    readonly dimensions: number
    readonly batchSize: number
    readonly chunkDocument: (
      document: EmbeddingDocument
    ) => Effect.Effect<ReadonlyArray<EmbeddingDocumentChunk>, EmbeddingModelError>
    readonly embed: (
      texts: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<Float32Array>, EmbeddingModelError>
  }
>()("@arden-hq/server/embedding/EmbeddingModel") {}
