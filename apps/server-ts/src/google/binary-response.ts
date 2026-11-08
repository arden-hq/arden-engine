import { formatBytes } from "@arden-hq/std/count"

export const googleBinaryResponse = async (
  response: Response,
  maxBytes: number
): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length"))
  const tooLarge = () => new Error(`The Google file exceeds ${formatBytes(maxBytes)}.`)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw tooLarge()
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw tooLarge()
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
