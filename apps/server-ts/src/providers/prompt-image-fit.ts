import { createHash } from "node:crypto"

import {
  resolveModelCapabilities,
  type ChatMessage,
  type ImageInputLimits,
  type Metadata,
  type ModelProvider,
  type ModelProviderRequest
} from "@arden-hq/loop"

import { fitsLimits, imageSize, patchCount, type ImageSize } from "../lib/prompt-image.js"
import { resizePromptPng, type PromptPngResize } from "./prompt-image-worker-client.js"

export interface FittedPromptImage {
  readonly digest: string
  readonly source: ImageSize
  readonly outcome:
    | { readonly kind: "resized"; readonly size: ImageSize }
    | { readonly kind: "omitted" }
}

type ImageCache = Map<string, ReadonlyArray<Metadata>>

const CACHE_ENTRIES = 32
const CACHE_ENCODED_BYTES = 24 * 1024 * 1024

export const withPromptImageFit = (
  provider: ModelProvider,
  report: (fitted: ReadonlyArray<FittedPromptImage>, model: string) => void
): ModelProvider => {
  const cache: ImageCache = new Map()
  const reported = new Set<string>()
  const fit = async (request: ModelProviderRequest): Promise<ModelProviderRequest> => {
    const limits = (await resolveModelCapabilities({ provider, model: request.model })).imageInput
    if (limits === undefined) return request
    const result = await fitPromptImages({
      messages: request.messages,
      limits,
      cache,
      resize: resizePromptPng,
      signal: request.signal
    })
    const fresh = result.fitted.filter((image) => !reported.has(image.digest))
    for (const image of fresh) {
      reported.add(image.digest)
      const oldest = reported.values().next()
      if (reported.size > CACHE_ENTRIES && !oldest.done) reported.delete(oldest.value)
    }
    if (fresh.length > 0) report(fresh, request.model)
    return result.messages === request.messages
      ? request
      : { ...request, messages: result.messages }
  }
  const fitting = (stream: ModelProvider["stream"]): ModelProvider["stream"] =>
    async function* (request) {
      yield* await stream(await fit(request))
    }
  const openSession = provider.openSession
  return {
    ...provider,
    stream: fitting(provider.stream),
    ...(openSession === undefined
      ? {}
      : {
          openSession: async () => {
            const session = await openSession()
            return { ...session, stream: fitting(session.stream) }
          }
        })
  }
}

const fitPromptImages = async (input: {
  readonly messages: ReadonlyArray<ChatMessage>
  readonly limits: ImageInputLimits
  readonly cache?: ImageCache
  readonly resize: PromptPngResize
  readonly signal?: AbortSignal | undefined
}): Promise<{
  readonly messages: ReadonlyArray<ChatMessage>
  readonly fitted: ReadonlyArray<FittedPromptImage>
}> => {
  const fitted: Array<FittedPromptImage> = []
  const cache = input.cache ?? new Map()
  let changed = false
  const messages: ChatMessage[] = []
  for (const message of input.messages) {
    input.signal?.throwIfAborted()
    if (
      message.role !== "user" ||
      typeof message.content !== "object" ||
      message.content === null
    ) {
      messages.push(message)
      continue
    }
    const content: Metadata[] = []
    let messageChanged = false
    for (const block of message.content) {
      const size = oversized(block, input.limits)
      if (size === undefined || typeof block.data !== "string") {
        content.push(block)
        continue
      }
      messageChanged = true
      const digest = createHash("sha1").update(block.data).digest("hex")
      const key = `${digest}:${block.media_type}:${input.limits.patchSize}:${input.limits.fitSide}:${input.limits.fitPatches}:${input.limits.maxPatches}`
      const cached = cache.get(key)
      const blocks =
        cached ??
        (await fitBlock({
          data: block.data,
          mediaType: String(block.media_type),
          size,
          limits: input.limits,
          digest,
          fitted,
          resize: input.resize,
          signal: input.signal
        }))
      input.signal?.throwIfAborted()
      if (cached === undefined) remember(cache, key, blocks)
      content.push(...blocks)
    }
    changed ||= messageChanged
    messages.push(messageChanged ? { ...message, content } : message)
  }
  return { messages: changed ? messages : input.messages, fitted }
}

const oversized = (block: Metadata, limits: ImageInputLimits): ImageSize | undefined => {
  if (
    block.type !== "image" ||
    typeof block.data !== "string" ||
    typeof block.media_type !== "string"
  ) {
    return undefined
  }
  const bytes = Buffer.from(
    block.media_type === "image/png" ? block.data.slice(0, 44) : block.data,
    "base64"
  )
  const size = imageSize(bytes, block.media_type)
  if (size === undefined) return undefined
  return fitsLimits(
    size,
    { maxSide: limits.fitSide, maxPatches: limits.fitPatches },
    limits.patchSize
  )
    ? undefined
    : size
}

const fitBlock = async (input: {
  readonly data: string
  readonly mediaType: string
  readonly size: ImageSize
  readonly limits: ImageInputLimits
  readonly digest: string
  readonly fitted: Array<FittedPromptImage>
  readonly resize: PromptPngResize
  readonly signal?: AbortSignal | undefined
}): Promise<ReadonlyArray<Metadata>> => {
  const resized =
    input.mediaType === "image/png"
      ? await input.resize({ data: input.data, limits: input.limits, signal: input.signal })
      : undefined
  const dimensions = `${input.size.width}x${input.size.height}`
  if (resized !== undefined) {
    input.fitted.push({
      digest: input.digest,
      source: input.size,
      outcome: { kind: "resized", size: resized.size }
    })
    return [
      { type: "image", media_type: "image/png", data: resized.data },
      {
        type: "text",
        text: `This image was resized from ${dimensions} to ${resized.size.width}x${resized.size.height} pixels to fit the model's image limit.`
      }
    ]
  }
  if (patchCount(input.size, input.limits.patchSize) <= input.limits.maxPatches) {
    return [{ type: "image", media_type: input.mediaType, data: input.data }]
  }
  input.fitted.push({ digest: input.digest, source: input.size, outcome: { kind: "omitted" } })
  return [
    {
      type: "text",
      text: `An image of ${dimensions} pixels was left out here: it is larger than the model accepts.`
    }
  ]
}

const remember = (cache: ImageCache, digest: string, blocks: ReadonlyArray<Metadata>): void => {
  cache.set(digest, blocks)
  const bytes = () =>
    [...cache.values()].reduce(
      (total, entries) =>
        total +
        entries.reduce(
          (sum, entry) => sum + (typeof entry.data === "string" ? entry.data.length : 0),
          0
        ),
      0
    )
  while (cache.size > CACHE_ENTRIES || bytes() > CACHE_ENCODED_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}
