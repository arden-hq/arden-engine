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

export type EmbeddingModelRef =
  | { readonly kind: "none" }
  | { readonly kind: "model"; readonly modelId: string }

export type EmbeddingEta =
  | { readonly kind: "estimating" }
  | { readonly kind: "estimated"; readonly seconds: number }

interface EmbeddingIndexCatalog extends JsonRecord {
  readonly models: ReadonlyArray<EmbeddingModelInfo>
  readonly indexes: ReadonlyArray<EmbeddingStoredIndex>
}

interface EmbeddingIndexProgress extends EmbeddingIndexCatalog {
  readonly modelId: string
  readonly indexedPages: number
  readonly totalPages: number
}

interface EmbeddingIndexOff extends EmbeddingIndexCatalog {
  readonly state: "off"
  readonly kept: EmbeddingModelRef
}

interface EmbeddingIndexUnavailable extends EmbeddingIndexCatalog {
  readonly state: "unavailable"
  readonly modelId: string
}

interface EmbeddingIndexDone extends EmbeddingIndexProgress {
  readonly state: "done"
}

interface EmbeddingIndexIndexing extends EmbeddingIndexProgress {
  readonly state: "indexing"
  readonly previous: EmbeddingModelRef
  readonly startedAt: string
  readonly phase: "loading" | "pages"
  readonly eta: EmbeddingEta
}

interface EmbeddingIndexPaused extends EmbeddingIndexProgress {
  readonly state: "paused"
  readonly previous: EmbeddingModelRef
  readonly startedAt: string
}

interface EmbeddingIndexFailed extends EmbeddingIndexProgress {
  readonly state: "failed"
  readonly previous: EmbeddingModelRef
  readonly error: string
}

export type EmbeddingIndexStatus =
  | EmbeddingIndexOff
  | EmbeddingIndexUnavailable
  | EmbeddingIndexDone
  | EmbeddingIndexIndexing
  | EmbeddingIndexPaused
  | EmbeddingIndexFailed

export const EMBEDDING_STATE = {
  off: "off",
  unavailable: "unavailable",
  done: "done",
  indexing: "indexing",
  paused: "paused",
  failed: "failed"
} as const

export const EMBEDDING_MODEL_REF = { none: "none", model: "model" } as const

export const isEmbeddingSearchStopped = (
  status: EmbeddingIndexStatus
): status is EmbeddingIndexOff | EmbeddingIndexUnavailable =>
  status.state === EMBEDDING_STATE.off || status.state === EMBEDDING_STATE.unavailable

export const embeddingSearchUsesModel = (
  status: EmbeddingIndexStatus,
  modelId: string
): boolean => {
  switch (status.state) {
    case EMBEDDING_STATE.off:
    case EMBEDDING_STATE.unavailable:
      return false
    case EMBEDDING_STATE.done:
      return status.modelId === modelId
    case EMBEDDING_STATE.indexing:
    case EMBEDDING_STATE.paused:
    case EMBEDDING_STATE.failed:
      return (
        status.modelId === modelId ||
        (status.previous.kind === EMBEDDING_MODEL_REF.model && status.previous.modelId === modelId)
      )
  }
}

/** Which model embeds the Wiki, or Off, keeping or deleting the current index. */
export type EmbeddingModelChoice =
  | { readonly kind: "model"; readonly modelId: string }
  | { readonly kind: "off"; readonly keepIndex: boolean }
