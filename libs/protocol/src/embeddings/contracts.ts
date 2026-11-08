import type { JsonRecord } from "../common/json.js"

/** An embedding model Arden can run now. */
export interface EmbeddingModelInfo extends JsonRecord {
  readonly modelId: string
  readonly dimensions: number
}

/** A vector index stored on this Mac and the bytes its vectors and chunk text take. */
export interface EmbeddingStoredIndex extends JsonRecord {
  readonly modelId: string
  readonly role: "serving" | "building"
  readonly bytes: number
}

interface EmbeddingIndexIdle extends JsonRecord {
  readonly state: "idle"
  /** The model whose index was kept when search was turned off; turning it on needs no re-index. */
  readonly keptModelId: string | null
  /** The model the person chose that is not installed, so search uses words only; null when Off by choice. */
  readonly unavailableModelId: string | null
  readonly models: ReadonlyArray<EmbeddingModelInfo>
  readonly indexes: ReadonlyArray<EmbeddingStoredIndex>
}

interface EmbeddingIndexDone extends JsonRecord {
  readonly state: "done"
  readonly modelId: string
  readonly indexedPages: number
  readonly totalPages: number
  readonly models: ReadonlyArray<EmbeddingModelInfo>
  readonly indexes: ReadonlyArray<EmbeddingStoredIndex>
}

interface EmbeddingIndexJob extends JsonRecord {
  readonly state: "indexing" | "paused"
  readonly modelId: string
  /** The model search uses until this job finishes; null when there is none. */
  readonly previousModelId: string | null
  readonly indexedPages: number
  readonly totalPages: number
  readonly startedAt: string
  /** `loading` while the model starts, before its first page; `pages` after (and while paused). */
  readonly phase: "loading" | "pages"
  /** Rough seconds left; null until enough pages finished in this run. */
  readonly etaSeconds: number | null
  readonly models: ReadonlyArray<EmbeddingModelInfo>
  readonly indexes: ReadonlyArray<EmbeddingStoredIndex>
}

interface EmbeddingIndexFailed extends JsonRecord {
  readonly state: "failed"
  readonly modelId: string
  readonly previousModelId: string | null
  readonly indexedPages: number
  readonly totalPages: number
  readonly error: string
  readonly models: ReadonlyArray<EmbeddingModelInfo>
  readonly indexes: ReadonlyArray<EmbeddingStoredIndex>
}

/**
 * Wiki semantic search state.
 *
 * - `idle`: embeddings are off (or no model can run); no embedding work, word search only.
 *   The last index may be kept (`keptModelId`).
 * - `done`: the chosen model's index is the one search uses.
 * - `indexing` / `paused`: a new index for `modelId` is built beside the previous model's,
 *   which search keeps using until the new one covers every page.
 * - `failed`: the last indexing step failed; it is tried again on the next change or resume.
 */
export type EmbeddingIndexStatus =
  | EmbeddingIndexIdle
  | EmbeddingIndexDone
  | EmbeddingIndexJob
  | EmbeddingIndexFailed

/** Which model embeds the Wiki, or Off, keeping or deleting the current index. */
export type EmbeddingModelChoice =
  | { readonly kind: "model"; readonly modelId: string }
  | { readonly kind: "off"; readonly keepIndex: boolean }
