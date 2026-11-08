import { crc32, deflateSync, inflateSync } from "node:zlib"

export interface RgbaImage {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Samples per pixel by PNG color type: gray, RGB, palette, gray+alpha, RGBA. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export const pngSize = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  if (bytes.length < 24 || !SIGNATURE.equals(bytes.subarray(0, 8))) return undefined
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.toString("latin1", 12, 16) !== "IHDR") return undefined
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) }
}

export const decodePng = (bytes: Uint8Array): RgbaImage | undefined => {
  const size = pngSize(bytes)
  if (size === undefined) return undefined
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const bitDepth = view[24] ?? 0
  const colorType = view[25] ?? -1
  const interlace = view[28]
  const channels = CHANNELS[colorType]
  if (channels === undefined || interlace !== 0 || ![1, 2, 4, 8, 16].includes(bitDepth)) {
    return undefined
  }
  const chunks = readChunks(view)
  if (chunks === undefined) return undefined
  const data = chunks.data.length === 0 ? undefined : inflate(Buffer.concat(chunks.data))
  if (data === undefined) return undefined
  const rowBytes = Math.ceil((size.width * channels * bitDepth) / 8)
  if (data.length < (rowBytes + 1) * size.height) return undefined
  const raw = unfilter(data, rowBytes, size.height, Math.max(1, (channels * bitDepth) / 8))
  if (raw === undefined) return undefined
  const pixels = new Uint8Array(size.width * size.height * 4)
  const maxSample = (1 << Math.min(bitDepth, 8)) - 1
  const sample = (row: number, index: number): number => {
    const offset = row * rowBytes
    if (bitDepth === 16) return raw[offset + index * 2] ?? 0
    if (bitDepth === 8) return raw[offset + index] ?? 0
    const perByte = 8 / bitDepth
    const byte = raw[offset + Math.floor(index / perByte)] ?? 0
    const shift = 8 - bitDepth * ((index % perByte) + 1)
    return (byte >> shift) & maxSample
  }
  const scale = (value: number): number =>
    colorType === 3 || bitDepth >= 8 ? value : Math.round((value * 255) / maxSample)
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const out = (y * size.width + x) * 4
      const first = x * channels
      if (colorType === 3) {
        const entry = sample(y, first)
        pixels[out] = chunks.palette[entry * 3] ?? 0
        pixels[out + 1] = chunks.palette[entry * 3 + 1] ?? 0
        pixels[out + 2] = chunks.palette[entry * 3 + 2] ?? 0
        pixels[out + 3] = chunks.transparency[entry] ?? 255
        continue
      }
      const gray = colorType === 0 || colorType === 4
      const red = scale(sample(y, first))
      pixels[out] = red
      pixels[out + 1] = gray ? red : scale(sample(y, first + 1))
      pixels[out + 2] = gray ? red : scale(sample(y, first + 2))
      pixels[out + 3] =
        colorType === 4 || colorType === 6 ? scale(sample(y, first + channels - 1)) : 255
    }
  }
  return { width: size.width, height: size.height, pixels }
}

export const encodePng = (image: RgbaImage): Buffer => {
  const opaque = image.pixels.every((value, index) => index % 4 !== 3 || value === 255)
  const channels = opaque ? 3 : 4
  const rowBytes = image.width * channels
  const rows = Buffer.alloc((rowBytes + 1) * image.height)
  const current = new Uint8Array(rowBytes)
  let previous = new Uint8Array(rowBytes)
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        current[x * channels + c] = image.pixels[(y * image.width + x) * 4 + c] ?? 0
      }
    }
    const { filter, line } = bestFilter(current, previous, channels)
    const offset = y * (rowBytes + 1)
    rows[offset] = filter
    rows.set(line, offset + 1)
    previous = current.slice()
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = opaque ? 2 : 6
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0))
  ])
}

const readChunks = (
  view: Buffer
): { data: Array<Buffer>; palette: Uint8Array; transparency: Uint8Array } | undefined => {
  const data: Array<Buffer> = []
  let palette: Uint8Array = new Uint8Array(0)
  let transparency: Uint8Array = new Uint8Array(0)
  let offset = 8
  while (offset + 8 <= view.length) {
    const length = view.readUInt32BE(offset)
    const type = view.toString("latin1", offset + 4, offset + 8)
    const body = view.subarray(offset + 8, offset + 8 + length)
    if (body.length !== length) return undefined
    if (type === "IDAT") data.push(body)
    if (type === "PLTE") palette = body
    if (type === "tRNS") transparency = body
    if (type === "IEND") break
    offset += 12 + length
  }
  return { data, palette, transparency }
}

const inflate = (data: Buffer): Buffer | undefined => {
  try {
    return inflateSync(data)
  } catch {
    return undefined
  }
}

const unfilter = (
  data: Buffer,
  rowBytes: number,
  height: number,
  bpp: number
): Uint8Array | undefined => {
  const out = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y += 1) {
    const filter = data[y * (rowBytes + 1)] ?? 5
    if (filter > 4) return undefined
    const source = y * (rowBytes + 1) + 1
    const row = y * rowBytes
    for (let i = 0; i < rowBytes; i += 1) {
      const raw = data[source + i] ?? 0
      const left = i >= bpp ? (out[row + i - bpp] ?? 0) : 0
      const up = y > 0 ? (out[row - rowBytes + i] ?? 0) : 0
      const upLeft = y > 0 && i >= bpp ? (out[row - rowBytes + i - bpp] ?? 0) : 0
      out[row + i] = raw + predict(filter, left, up, upLeft)
    }
  }
  return out
}

const paeth = (left: number, up: number, upLeft: number): number => {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

/** The usual minimum-sum-of-absolute-differences choice among the five PNG filters. */
const bestFilter = (
  current: Uint8Array,
  previous: Uint8Array,
  bpp: number
): { filter: number; line: Uint8Array } => {
  let best = { filter: 0, line: current.slice(), cost: Number.POSITIVE_INFINITY }
  for (let filter = 0; filter <= 4; filter += 1) {
    const line = new Uint8Array(current.length)
    let cost = 0
    for (let i = 0; i < current.length; i += 1) {
      const value = current[i] ?? 0
      const left = i >= bpp ? (current[i - bpp] ?? 0) : 0
      const up = previous[i] ?? 0
      const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0
      const predicted = predict(filter, left, up, upLeft)
      const residual = (value - predicted) & 0xff
      line[i] = residual
      cost += residual < 128 ? residual : 256 - residual
    }
    if (cost < best.cost) best = { filter, line, cost }
  }
  return { filter: best.filter, line: best.line }
}

const predict = (filter: number, left: number, up: number, upLeft: number): number => {
  switch (filter) {
    case 1:
      return left
    case 2:
      return up
    case 3:
      return (left + up) >> 1
    case 4:
      return paeth(left, up, upLeft)
    default:
      return 0
  }
}

const chunk = (type: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, "latin1")
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, tail])
}
