import type { JsonRecord } from "../common/json.js"

export const EMBEDDING_STATE = {
  off: "off",
  unavailable: "unavailable",
  done: "done",
  indexing: "indexing",
  paused: "paused",
  failed: "failed"
} as const

export const EMBEDDING_MODEL_REF = { none: "none", model: "model" } as const

export type EmbeddingIndexState = (typeof EMBEDDING_STATE)[keyof typeof EMBEDDING_STATE]

export const EMBEDDING_INDEX_ROLE = { serving: "serving", building: "building" } as const

export type EmbeddingIndexRole = (typeof EMBEDDING_INDEX_ROLE)[keyof typeof EMBEDDING_INDEX_ROLE]

export const EMBEDDING_ETA = { estimating: "estimating", estimated: "estimated" } as const

export const EMBEDDING_PHASE = { loading: "loading", pages: "pages" } as const

export type EmbeddingPhase = (typeof EMBEDDING_PHASE)[keyof typeof EMBEDDING_PHASE]

export const EMBEDDING_MODEL_CHOICE = { model: "model", off: "off" } as const

export interface EmbeddingModelInfo extends JsonRecord {
  readonly modelId: string
  readonly dimensions: number
}

export interface EmbeddingStoredIndex extends JsonRecord {
  readonly modelId: string
  readonly role: EmbeddingIndexRole
  readonly bytes: number
}

export type EmbeddingModelRef =
  | { readonly kind: typeof EMBEDDING_MODEL_REF.none }
  | { readonly kind: typeof EMBEDDING_MODEL_REF.model; readonly modelId: string }

export type EmbeddingEta =
  | { readonly kind: typeof EMBEDDING_ETA.estimating }
  | { readonly kind: typeof EMBEDDING_ETA.estimated; readonly seconds: number }

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
  readonly state: typeof EMBEDDING_STATE.off
  readonly kept: EmbeddingModelRef
}

interface EmbeddingIndexUnavailable extends EmbeddingIndexCatalog {
  readonly state: typeof EMBEDDING_STATE.unavailable
  readonly modelId: string
}

interface EmbeddingIndexDone extends EmbeddingIndexProgress {
  readonly state: typeof EMBEDDING_STATE.done
}

interface EmbeddingIndexIndexing extends EmbeddingIndexProgress {
  readonly state: typeof EMBEDDING_STATE.indexing
  readonly previous: EmbeddingModelRef
  readonly startedAt: string
  readonly phase: EmbeddingPhase
  readonly eta: EmbeddingEta
}

interface EmbeddingIndexPaused extends EmbeddingIndexProgress {
  readonly state: typeof EMBEDDING_STATE.paused
  readonly previous: EmbeddingModelRef
  readonly startedAt: string
}

interface EmbeddingIndexFailed extends EmbeddingIndexProgress {
  readonly state: typeof EMBEDDING_STATE.failed
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

export type EmbeddingModelChoice =
  | { readonly kind: typeof EMBEDDING_MODEL_CHOICE.model; readonly modelId: string }
  | { readonly kind: typeof EMBEDDING_MODEL_CHOICE.off; readonly keepIndex: boolean }
