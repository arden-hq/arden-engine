import { Effect, Layer, Schema } from "effect"

import type { EmbeddingManifest } from "./catalog.js"
import { LlamaServer, type LlamaServerError } from "./llama-server.js"
import {
  EmbeddingModel,
  EmbeddingModelError,
  type EmbeddingDocument,
  type EmbeddingDocumentChunk
} from "../embedding/model.js"
import type { EmbeddingModelSource } from "../embedding/models.js"

const MAX_TOKENS = 512
const OVERLAP_TOKENS = 64
const MAX_PREFIX_TOKENS = 128
const BATCH_SIZE = 8
const SURELY_SHORT_CHARACTERS = MAX_TOKENS - 2

const TokenizeSchema = Schema.Struct({ tokens: Schema.Array(Schema.Int) })
const DetokenizeSchema = Schema.Struct({ content: Schema.String })
const EmbeddingsSchema = Schema.Struct({
  data: Schema.Array(Schema.Struct({ index: Schema.Int, embedding: Schema.Array(Schema.Number) }))
})

const modelError = (
  operation: EmbeddingModelError["operation"],
  message: string,
  cause?: unknown
) => new EmbeddingModelError({ operation, message, ...(cause === undefined ? {} : { cause }) })

const localEmbeddingIndexVersion = (manifest: EmbeddingManifest): string => {
  const weights = manifest.files.find((file) => file.role === "weights")
  return `${manifest.id}@${weights?.sha256.slice(0, 16) ?? "unknown"}:llama-server:${manifest.pooling}:l2:${MAX_TOKENS}:${OVERLAP_TOKENS}:v1`
}

const makeModel = (
  llama: LlamaServer["Service"],
  manifest: EmbeddingManifest
): EmbeddingModel["Service"] => {
  const post = <S extends Schema.Top>(
    operation: EmbeddingModelError["operation"],
    route: string,
    body: Record<string, unknown>,
    schema: S
  ) =>
    llama.request(route, { body: { model: manifest.id, ...body } }).pipe(
      Effect.mapError((error: LlamaServerError) => modelError(operation, error.message, error)),
      Effect.flatMap((response) =>
        response.status === 200
          ? Schema.decodeUnknownEffect(schema)(response.body).pipe(
              Effect.mapError((cause) =>
                modelError(operation, `Unexpected answer from ${route}`, cause)
              )
            )
          : Effect.fail(modelError(operation, `${route} answered ${response.status}`))
      )
    )

  const tokenize = (operation: EmbeddingModelError["operation"], content: string) =>
    post(operation, "/tokenize", { content, add_special: false }, TokenizeSchema).pipe(
      Effect.map((result) => result.tokens)
    )
  const detokenize = (operation: EmbeddingModelError["operation"], tokens: ReadonlyArray<number>) =>
    post(operation, "/detokenize", { tokens }, DetokenizeSchema).pipe(
      Effect.map((result) => result.content)
    )

  const chunkDocument = Effect.fn("LocalEmbedding.chunkDocument")(function* (
    document: EmbeddingDocument
  ) {
    if (document.body.trim() === "") return []
    const prefixIds = (yield* tokenize(
      "chunk",
      `Title: ${document.title}\nPath: ${document.path}`
    )).slice(0, MAX_PREFIX_TOKENS)
    const prefix = `${(yield* detokenize("chunk", prefixIds)).trim()}\n\n`
    const chunkSize = MAX_TOKENS - prefixIds.length - 2
    const step = Math.max(1, chunkSize - OVERLAP_TOKENS)
    const body = yield* tokenize("chunk", document.body)
    const chunks: Array<EmbeddingDocumentChunk> = []
    for (let start = 0; start < body.length; start += step) {
      const text = (yield* detokenize("chunk", body.slice(start, start + chunkSize))).trim()
      if (text !== "") chunks.push({ text: `${prefix}${text}`, excerpt: text })
      if (start + chunkSize >= body.length) break
    }
    return chunks
  })

  const fit = (text: string) =>
    text.length <= SURELY_SHORT_CHARACTERS
      ? Effect.succeed(text)
      : tokenize("embed", text).pipe(
          Effect.flatMap((tokens) =>
            tokens.length <= MAX_TOKENS - 2
              ? Effect.succeed(text)
              : detokenize("embed", tokens.slice(0, MAX_TOKENS - 2))
          )
        )

  const embed = Effect.fn("LocalEmbedding.embed")(function* (texts: ReadonlyArray<string>) {
    if (texts.length === 0) return []
    if (texts.length > BATCH_SIZE) {
      return yield* modelError("embed", `At most ${BATCH_SIZE} texts per batch`)
    }
    const input = yield* Effect.forEach(texts, fit)
    const result = yield* post(
      "embed",
      "/v1/embeddings",
      { input, encoding_format: "float" },
      EmbeddingsSchema
    )
    const ordered = [...result.data].sort((left, right) => left.index - right.index)
    if (ordered.length !== texts.length) {
      return yield* modelError("embed", `Expected ${texts.length} vectors, got ${ordered.length}`)
    }
    return yield* Effect.forEach(ordered, (entry) => {
      const norm = Math.sqrt(entry.embedding.reduce((sum, value) => sum + value * value, 0))
      return entry.embedding.length !== manifest.dimensions || !Number.isFinite(norm) || norm === 0
        ? Effect.fail(modelError("embed", "The model returned an unexpected vector"))
        : Effect.succeed(Float32Array.from(entry.embedding, (value) => value / norm))
    })
  })

  return EmbeddingModel.of({
    modelId: manifest.id,
    indexVersion: localEmbeddingIndexVersion(manifest),
    dimensions: manifest.dimensions,
    batchSize: BATCH_SIZE,
    chunkDocument,
    embed
  })
}

export const localEmbeddingSource = Effect.fn("LocalEmbedding.source")(function* (
  manifest: EmbeddingManifest,
  available: () => Effect.Effect<boolean>
) {
  const llama = yield* LlamaServer
  return {
    modelId: manifest.id,
    indexVersion: localEmbeddingIndexVersion(manifest),
    dimensions: manifest.dimensions,
    available,
    layer: Layer.succeed(EmbeddingModel, makeModel(llama, manifest))
  } satisfies EmbeddingModelSource
})
