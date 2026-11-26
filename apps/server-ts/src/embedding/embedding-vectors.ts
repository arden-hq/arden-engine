import type { StoredWikiEmbeddingChunk } from "../persistence/memory/embedding-store.js"

export const bytes = (embedding: Float32Array): Uint8Array =>
  Uint8Array.from(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength))

export const vector = (chunk: StoredWikiEmbeddingChunk): Float32Array => {
  const copied = Uint8Array.from(chunk.embedding)
  return new Float32Array(copied.buffer, copied.byteOffset, copied.byteLength / 4)
}

export const similarity = (left: Float32Array, right: Float32Array): number => {
  let score = 0
  for (const [index, value] of left.entries()) {
    const other = right[index]
    if (other !== undefined) score += value * other
  }
  return score
}
