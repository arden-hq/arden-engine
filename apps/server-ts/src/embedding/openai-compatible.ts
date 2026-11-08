import { Effect, Layer, Schema } from "effect"

import { EndpointCallError, failureForStatus } from "../models/endpoints/failure.js"
import { EmbeddingModel, EmbeddingModelError, type EmbeddingDocumentChunk } from "./model.js"
import type { EmbeddingModelSource } from "./models.js"

export interface EmbeddingEndpoint {
  readonly modelId: string
  readonly baseUrl: string
  readonly model: string
  readonly headers: Readonly<Record<string, string>>
  readonly fetch: typeof globalThis.fetch
}

const CHUNK_CHARS = 2_000
const OVERLAP_CHARS = 200
const BATCH_SIZE = 16
const TIMEOUT_MS = 30_000

const normalizedBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/u, "")

const externalIndexVersion = ({
  baseUrl,
  model,
  dimensions
}: {
  readonly baseUrl: string
  readonly model: string
  readonly dimensions: number
}): string =>
  `openai-compatible:${normalizedBaseUrl(baseUrl)}:${model}:${String(dimensions)}:chars-${String(CHUNK_CHARS)}-${String(OVERLAP_CHARS)}:l2:v1`

const EmbeddingsResponseSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      embedding: Schema.Array(Schema.Finite).check(Schema.isMinLength(1))
    })
  )
})

const wrongFormat = (message: string, cause?: unknown) =>
  new EndpointCallError({
    reason: "wrong_format",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const decodeEmbeddingsResponse = Effect.fn("OpenAiCompatible.decode")(function* (
  body: unknown,
  { count, dimensions }: { readonly count: number; readonly dimensions: number | undefined }
) {
  const decoded = yield* Schema.decodeUnknownEffect(EmbeddingsResponseSchema)(body).pipe(
    Effect.mapError((cause) =>
      wrongFormat("The address did not answer in the OpenAI embeddings format", cause)
    )
  )
  const ordered = [...decoded.data].sort((left, right) => left.index - right.index)
  if (ordered.length !== count || ordered.some((item, position) => item.index !== position))
    return yield* wrongFormat(
      `The endpoint answered ${String(ordered.length)} of ${String(count)} texts`
    )
  const width = dimensions ?? ordered[0]?.embedding.length
  if (ordered.some((item) => item.embedding.length !== width))
    return yield* wrongFormat(`The endpoint answered vectors that are not ${String(width)} wide`)
  return yield* Effect.forEach(ordered, (item) => {
    const norm = Math.sqrt(item.embedding.reduce((sum, value) => sum + value * value, 0))
    return norm === 0
      ? Effect.fail(wrongFormat("The endpoint answered a zero vector"))
      : Effect.succeed(Float32Array.from(item.embedding, (value) => value / norm))
  })
})

const requestEmbeddings = (
  endpoint: Pick<EmbeddingEndpoint, "baseUrl" | "model" | "headers" | "fetch">,
  texts: ReadonlyArray<string>,
  dimensions: number | undefined
): Effect.Effect<ReadonlyArray<Float32Array>, EndpointCallError> =>
  Effect.tryPromise({
    try: (signal) =>
      endpoint.fetch(`${normalizedBaseUrl(endpoint.baseUrl)}/embeddings`, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        headers: { ...endpoint.headers, "content-type": "application/json" },
        body: JSON.stringify({ model: endpoint.model, input: texts })
      }),
    catch: (cause) =>
      new EndpointCallError({ reason: "unreachable", message: "The address did not answer", cause })
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({
            try: (): Promise<unknown> => response.json(),
            catch: (cause) => wrongFormat("The endpoint answered with no JSON", cause)
          })
        : Effect.fail(
            new EndpointCallError({
              reason: failureForStatus(response.status),
              message: `The endpoint answered ${String(response.status)}`
            })
          )
    ),
    Effect.flatMap((body) => decodeEmbeddingsResponse(body, { count: texts.length, dimensions }))
  )

export const checkEmbeddingEndpoint = (
  endpoint: Pick<EmbeddingEndpoint, "baseUrl" | "model" | "headers" | "fetch">
): Effect.Effect<number, EndpointCallError> =>
  requestEmbeddings(endpoint, ["Check"], undefined).pipe(
    Effect.flatMap(([probe]) =>
      probe === undefined
        ? Effect.fail(wrongFormat("The endpoint answered no vector"))
        : Effect.succeed(probe.length)
    )
  )

const chunkDocument = ({
  title,
  path,
  body
}: {
  readonly title: string
  readonly path: string
  readonly body: string
}): ReadonlyArray<EmbeddingDocumentChunk> => {
  const text = body.trim()
  if (text === "") return []
  const prefix = `Title: ${title}\nPath: ${path}\n\n`
  const chunks: Array<EmbeddingDocumentChunk> = []
  for (let start = 0; start < text.length; start += CHUNK_CHARS - OVERLAP_CHARS) {
    const excerpt = text.slice(start, start + CHUNK_CHARS).trim()
    if (excerpt !== "") chunks.push({ text: `${prefix}${excerpt}`, excerpt })
    if (start + CHUNK_CHARS >= text.length) break
  }
  return chunks
}

export const openAiCompatibleSource = (
  endpoint: EmbeddingEndpoint,
  dimensions: number,
  onOutcome: (outcome: EndpointCallError | undefined) => Effect.Effect<void>
): EmbeddingModelSource => {
  const indexVersion = externalIndexVersion({ ...endpoint, dimensions })
  return {
    modelId: endpoint.modelId,
    indexVersion,
    dimensions,
    layer: Layer.succeed(
      EmbeddingModel,
      EmbeddingModel.of({
        modelId: endpoint.modelId,
        indexVersion,
        dimensions,
        batchSize: BATCH_SIZE,
        chunkDocument: (document) => Effect.succeed(chunkDocument(document)),
        embed: (texts) =>
          texts.length === 0
            ? Effect.succeed([])
            : requestEmbeddings(endpoint, texts, dimensions).pipe(
                Effect.tap(() => onOutcome(undefined)),
                Effect.tapError(onOutcome),
                Effect.mapError(
                  (cause) =>
                    new EmbeddingModelError({ operation: "embed", message: cause.message, cause })
                )
              )
      })
    )
  }
}
