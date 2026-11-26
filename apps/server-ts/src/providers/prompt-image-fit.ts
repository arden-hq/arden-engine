import { ROLE } from "@arden-hq/std/message-vocabulary"
import { createHash } from "node:crypto"

import {
  resolveModelCapabilities,
  type ChatMessage,
  type ImageInputLimits,
  type ContentBlock,
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

type FittedBlock =
  | { readonly type: "image"; readonly media_type: string; readonly data: string }
  | { readonly type: "text"; readonly text: string }

type ImageCache = Map<string, ReadonlyArray<FittedBlock>>

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
      ?.limits
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

export const fitPromptImages = async (input: {
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
  const fitBlocks = async <Block extends Metadata | ContentBlock>(
    blocks: ReadonlyArray<Block>
  ): Promise<ReadonlyArray<Block | FittedBlock> | undefined> => {
    const content: Array<Block | FittedBlock> = []
    let blocksChanged = false
    for (const block of blocks) {
      const image = oversized(block, input.limits)
      if (image === undefined) {
        content.push(block)
        continue
      }
      blocksChanged = true
      const digest = createHash("sha1").update(image.data).digest("hex")
      const key = `${digest}:${image.mediaType}:${input.limits.patchSize}:${input.limits.fitSide}:${input.limits.fitPatches}:${input.limits.maxPatches}`
      const cached = cache.get(key)
      const fittedBlocks =
        cached ??
        (await fitBlock({
          data: image.data,
          mediaType: image.mediaType,
          size: image.size,
          limits: input.limits,
          digest,
          fitted,
          resize: input.resize,
          signal: input.signal
        }))
      input.signal?.throwIfAborted()
      if (cached === undefined) remember(cache, key, fittedBlocks)
      content.push(...fittedBlocks)
    }
    return blocksChanged ? content : undefined
  }
  let changed = false
  const messages: ChatMessage[] = []
  for (const message of input.messages) {
    input.signal?.throwIfAborted()
    if (message.role === ROLE.tool && message.model_content !== undefined) {
      const modelContent = await fitBlocks(message.model_content)
      changed ||= modelContent !== undefined
      messages.push(
        modelContent === undefined ? message : { ...message, model_content: modelContent }
      )
      continue
    }
    if (
      (message.role !== ROLE.user && message.role !== ROLE.interaction) ||
      typeof message.content !== "object" ||
      message.content === null
    ) {
      messages.push(message)
      continue
    }
    const content = await fitBlocks(message.content)
    changed ||= content !== undefined
    messages.push(content === undefined ? message : { ...message, content })
  }
  return { messages: changed ? messages : input.messages, fitted }
}

const oversized = (
  block: Metadata | ContentBlock,
  limits: ImageInputLimits
): { readonly data: string; readonly mediaType: string; readonly size: ImageSize } | undefined => {
  if (block.type !== "image" || !("data" in block) || !("media_type" in block)) return undefined
  const { data, media_type: mediaType } = block
  if (typeof data !== "string" || typeof mediaType !== "string") return undefined
  const bytes = Buffer.from(mediaType === "image/png" ? data.slice(0, 44) : data, "base64")
  const size = imageSize(bytes, mediaType)
  if (size === undefined) return undefined
  return fitsLimits(
    size,
    { maxSide: limits.fitSide, maxPatches: limits.fitPatches },
    limits.patchSize
  )
    ? undefined
    : { data, mediaType, size }
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
}): Promise<ReadonlyArray<FittedBlock>> => {
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

const remember = (cache: ImageCache, digest: string, blocks: ReadonlyArray<FittedBlock>): void => {
  cache.set(digest, blocks)
  const bytes = () =>
    [...cache.values()].reduce(
      (total, entries) =>
        total +
        entries.reduce((sum, entry) => sum + (entry.type === "image" ? entry.data.length : 0), 0),
      0
    )
  while (cache.size > CACHE_ENTRIES || bytes() > CACHE_ENCODED_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}
