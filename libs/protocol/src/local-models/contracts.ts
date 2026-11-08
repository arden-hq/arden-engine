import type { JsonRecord } from "../common/json.js"

/**
 * Where one downloadable model stands on this Mac.
 *
 * - `absent`: nothing on disk.
 * - `downloading`: bytes are arriving; a download in this state when Arden
 *   quits resumes after the next start.
 * - `stopped`: the user stopped it; the bytes so far are kept and Install resumes.
 * - `failed`: `network` (the connection broke or the server refused; Install
 *   resumes from the kept bytes), `hash` (the file did not match; its bytes
 *   were deleted, Install starts over) or `disk` (the disk refused a write).
 * - `no_space`: the disk lacks room for the rest of the download; nothing more
 *   was downloaded. `neededBytes` is what is still to come plus 1 GB Arden
 *   keeps free, so the disk never fills to the last byte.
 * - `installed`: every file is on disk and verified.
 */
export type LocalModelInstall =
  | { readonly state: "absent" }
  | {
      readonly state: "downloading" | "stopped"
      readonly receivedBytes: number
      readonly totalBytes: number
    }
  | {
      readonly state: "failed"
      readonly reason: "network" | "hash" | "disk"
      readonly receivedBytes: number
      readonly totalBytes: number
    }
  | {
      readonly state: "no_space"
      readonly neededBytes: number
      readonly freeBytes: number
    }
  | { readonly state: "installed" }

/** One model of the curated catalog. */
export interface LocalModelInfo extends JsonRecord {
  readonly id: string
  /** embedding — Wiki search vectors; decision — option probabilities for typed questions. */
  readonly kind: "embedding" | "decision"
  readonly name: string
  /** The licence's name, and the page that holds its text. */
  readonly license: string
  readonly licenseUrl: string
  /** text+image models also read images (they carry a projector file). */
  readonly input: "text" | "text+image"
  /** Download size of every file together. */
  readonly totalBytes: number
  /** Vector width; null for decision models. */
  readonly dimensions: number | null
  readonly install: LocalModelInstall
}

/**
 * The helper process that runs installed models. It starts on first use and
 * stops with Arden; `failed` means it crashed three times in a row.
 */
export type LocalModelRuntime =
  | { readonly state: "stopped" | "starting" | "running" }
  | { readonly state: "failed"; readonly error: string }

export interface LocalModelsStatus extends JsonRecord {
  readonly models: ReadonlyArray<LocalModelInfo>
  /** Free bytes on the disk that holds the models; null when unknown. */
  readonly freeBytes: number | null
  readonly runtime: LocalModelRuntime
}
