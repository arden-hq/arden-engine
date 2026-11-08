import { Effect } from "effect"

import { fitImageWithSips } from "../../lib/image-fit-sips.js"
import { fitDimensions, fitPng, imageSize, type ImageSize } from "../../lib/prompt-image.js"
import type { CompletionImage } from "../structured-completion.js"
import { DecisionsError } from "./questions.js"

const JEV_MIN_SIDE = 280
const JEV_MAX_SIDE = 1568
const JEV_LIMITS = {
  patchSize: 1,
  fitSide: JEV_MAX_SIDE,
  fitPatches: JEV_MAX_SIDE * JEV_MAX_SIDE
} as const

const withinJevBounds = (size: ImageSize): boolean =>
  size.width >= JEV_MIN_SIDE &&
  size.height >= JEV_MIN_SIDE &&
  size.width <= JEV_MAX_SIDE &&
  size.height <= JEV_MAX_SIDE

export const fitJevImage = Effect.fn("Decisions.fitJevImage")(function* (
  image: CompletionImage,
  signal: AbortSignal | undefined
): Effect.fn.Return<CompletionImage, DecisionsError> {
  if (image.mediaType !== "image/png" && image.mediaType !== "image/jpeg") {
    return yield* new DecisionsError({
      reason: "invalid_request",
      message: "Jev images must be PNG or JPEG"
    })
  }
  const bytes = Buffer.from(image.data, "base64")
  const source = imageSize(bytes, image.mediaType)
  if (source === undefined) {
    return yield* new DecisionsError({
      reason: "invalid_request",
      message: "Jev could not read the image dimensions"
    })
  }
  if (withinJevBounds(source)) return image
  const target = fitDimensions(
    source,
    { maxSide: JEV_MAX_SIDE, maxPatches: JEV_LIMITS.fitPatches },
    JEV_LIMITS.patchSize
  )
  if (!withinJevBounds(target)) {
    return yield* new DecisionsError({
      reason: "invalid_request",
      message: "The image cannot fit Jev's minimum and maximum dimensions"
    })
  }
  const fitted = yield* Effect.tryPromise({
    try: async (effectSignal) => {
      const cancellation =
        signal === undefined ? effectSignal : AbortSignal.any([effectSignal, signal])
      const sips = await fitImageWithSips({
        source: { kind: "bytes", bytes },
        format: image.mediaType === "image/png" ? "png" : "jpeg",
        limits: JEV_LIMITS,
        signal: cancellation
      })
      if (sips !== undefined) return sips
      return image.mediaType === "image/png" ? fitPng({ bytes, limits: JEV_LIMITS }) : undefined
    },
    catch: (cause) =>
      new DecisionsError({
        reason: "provider",
        message: "Could not prepare the image for Jev",
        cause
      })
  })
  const size = fitted === undefined ? undefined : imageSize(fitted.data, fitted.mediaType)
  if (fitted === undefined || size === undefined || !withinJevBounds(size)) {
    return yield* new DecisionsError({
      reason: "invalid_request",
      message: "The image cannot be prepared within Jev's dimensions"
    })
  }
  return { mediaType: fitted.mediaType, data: fitted.data.toString("base64") }
})
