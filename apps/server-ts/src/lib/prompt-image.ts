import type { ImageInputLimits } from "@arden-hq/loop"

import { decodePng, encodePng, pngSize, type RgbaImage } from "./png.js"

export interface ImageSize {
  readonly width: number
  readonly height: number
}

/**
 * OpenAI Responses image input: 32 px patches, and a request with one image
 * over 30,000 of them is refused outright (developers.openai.com/api/docs/guides/images-vision).
 * Images are fitted to Codex's high-detail policy (`PromptImageMode::HIGH_DETAIL`:
 * 2048 px longest side, 2,500 patches), which Codex applies to every image sent
 * without an explicit detail — as Arden sends them.
 */
export const OPENAI_IMAGE_INPUT: ImageInputLimits = {
  patchSize: 32,
  fitSide: 2048,
  fitPatches: 2500,
  maxPatches: 30_000
}

export const patchCount = (size: ImageSize, patchSize: number): number =>
  Math.ceil(size.width / patchSize) * Math.ceil(size.height / patchSize)

export const fitsLimits = (
  size: ImageSize,
  limits: { readonly maxSide: number; readonly maxPatches: number },
  patchSize: number
): boolean =>
  size.width <= limits.maxSide &&
  size.height <= limits.maxSide &&
  patchCount(size, patchSize) <= limits.maxPatches

export const fitDimensions = (
  size: ImageSize,
  limits: { readonly maxSide: number; readonly maxPatches: number },
  patchSize: number
): ImageSize => {
  const source = { width: Math.max(1, size.width), height: Math.max(1, size.height) }
  if (fitsLimits(source, limits, patchSize)) return source
  const sideScale = Math.min(1, limits.maxSide / Math.max(source.width, source.height))
  const capped = {
    width: Math.max(1, Math.round(source.width * sideScale)),
    height: Math.max(1, Math.round(source.height * sideScale))
  }
  if (fitsLimits(capped, limits, patchSize)) return capped
  const areaScale = Math.sqrt(
    (patchSize * patchSize * limits.maxPatches) / capped.width / capped.height
  )
  const wide = (capped.width * areaScale) / patchSize
  const high = (capped.height * areaScale) / patchSize
  const scale = areaScale * Math.min(Math.floor(wide) / wide, Math.floor(high) / high)
  return {
    width: Math.max(1, Math.floor(capped.width * scale)),
    height: Math.max(1, Math.floor(capped.height * scale))
  }
}

export const imageSize = (bytes: Uint8Array, mediaType: string): ImageSize | undefined => {
  if (mediaType === "image/png") return pngSize(bytes)
  if (mediaType === "image/jpeg") return jpegSize(bytes)
  return undefined
}

export interface FittedImage {
  readonly mediaType: "image/png"
  readonly data: Buffer
  readonly source: ImageSize
  readonly size: ImageSize
}

export const fitPng = (options: {
  readonly bytes: Uint8Array
  readonly limits: Pick<ImageInputLimits, "patchSize" | "fitSide" | "fitPatches">
  readonly maxAspect?: number
}): FittedImage | undefined => {
  const decoded = decodePng(options.bytes)
  if (decoded === undefined) return undefined
  const source = { width: decoded.width, height: decoded.height }
  const cropped =
    options.maxAspect !== undefined && decoded.height > decoded.width * options.maxAspect
      ? cropTop(decoded, Math.round(decoded.width * options.maxAspect))
      : decoded
  const size = fitDimensions(
    cropped,
    { maxSide: options.limits.fitSide, maxPatches: options.limits.fitPatches },
    options.limits.patchSize
  )
  if (cropped === decoded && size.width === source.width && size.height === source.height) {
    return { mediaType: "image/png", data: Buffer.from(options.bytes), source, size }
  }
  return { mediaType: "image/png", data: encodePng(resample(cropped, size)), source, size }
}

const cropTop = (image: RgbaImage, height: number): RgbaImage => ({
  width: image.width,
  height,
  pixels: image.pixels.subarray(0, image.width * height * 4)
})

const resample = (image: RgbaImage, size: ImageSize): RgbaImage => {
  const wide = resampleAxis({
    pixels: image.pixels,
    lines: image.height,
    from: image.width,
    to: size.width,
    stride: 1,
    lineStride: image.width,
    outStride: 1,
    outLineStride: size.width
  })
  const pixels = resampleAxis({
    pixels: wide,
    lines: size.width,
    from: image.height,
    to: size.height,
    stride: size.width,
    lineStride: 1,
    outStride: size.width,
    outLineStride: 1
  })
  return { width: size.width, height: size.height, pixels }
}

const resampleAxis = (input: {
  readonly pixels: Uint8Array
  readonly lines: number
  readonly from: number
  readonly to: number
  readonly stride: number
  readonly lineStride: number
  readonly outStride: number
  readonly outLineStride: number
}): Uint8Array => {
  const out = new Uint8Array(input.lines * input.to * 4)
  const ratio = input.from / input.to
  const support = Math.max(1, ratio)
  const taps = Array.from({ length: input.to }, (_, index) => {
    const center = (index + 0.5) * ratio
    const first = Math.max(0, Math.floor(center - support))
    const last = Math.min(input.from - 1, Math.ceil(center + support))
    const weights: Array<number> = []
    for (let s = first; s <= last; s += 1) {
      weights.push(Math.max(0, 1 - Math.abs(s + 0.5 - center) / support))
    }
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    return { first, weights: weights.map((weight) => weight / total) }
  })
  for (let line = 0; line < input.lines; line += 1) {
    for (let index = 0; index < input.to; index += 1) {
      const tap = taps[index]
      if (tap === undefined) continue
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      for (let k = 0; k < tap.weights.length; k += 1) {
        const weight = tap.weights[k] ?? 0
        const at = (line * input.lineStride + (tap.first + k) * input.stride) * 4
        red += (input.pixels[at] ?? 0) * weight
        green += (input.pixels[at + 1] ?? 0) * weight
        blue += (input.pixels[at + 2] ?? 0) * weight
        alpha += (input.pixels[at + 3] ?? 0) * weight
      }
      const target = (line * input.outLineStride + index * input.outStride) * 4
      out[target] = Math.round(red)
      out[target + 1] = Math.round(green)
      out[target + 2] = Math.round(blue)
      out[target + 3] = Math.round(alpha)
    }
  }
  return out
}

/** Width and height from the first start-of-frame marker (SOF0–SOF15 except DHT, JPG, DAC). */
const jpegSize = (bytes: Uint8Array): ImageSize | undefined => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1] ?? 0
    if (marker === 0xff) {
      offset += 1
      continue
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0)
      }
    }
    offset += 2 + length
  }
  return undefined
}
