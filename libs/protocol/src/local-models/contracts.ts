import type { JsonRecord } from "../common/json.js"
import type { ModelEndpointInput } from "../model-endpoints/contracts.js"

export const LOCAL_MODEL_INSTALL_STATE = {
  absent: "absent",
  downloading: "downloading",
  stopped: "stopped",
  failed: "failed",
  noSpace: "no_space",
  installed: "installed"
} as const

export const LOCAL_MODEL_INSTALL_REASON = {
  network: "network",
  hash: "hash",
  disk: "disk"
} as const

export type LocalModelInstallReason =
  (typeof LOCAL_MODEL_INSTALL_REASON)[keyof typeof LOCAL_MODEL_INSTALL_REASON]

export type LocalModelInstall =
  | {
      readonly state:
        | typeof LOCAL_MODEL_INSTALL_STATE.absent
        | typeof LOCAL_MODEL_INSTALL_STATE.installed
    }
  | {
      readonly state:
        | typeof LOCAL_MODEL_INSTALL_STATE.downloading
        | typeof LOCAL_MODEL_INSTALL_STATE.stopped
      readonly receivedBytes: number
      readonly totalBytes: number
    }
  | {
      readonly state: typeof LOCAL_MODEL_INSTALL_STATE.failed
      readonly reason: LocalModelInstallReason
      readonly receivedBytes: number
      readonly totalBytes: number
    }
  | {
      readonly state: typeof LOCAL_MODEL_INSTALL_STATE.noSpace
      readonly neededBytes: number
      readonly freeBytes: number
    }

export const LOCAL_MODEL_KIND = { embedding: "embedding", decision: "decision" } as const

export type LocalModelKind = (typeof LOCAL_MODEL_KIND)[keyof typeof LOCAL_MODEL_KIND]

export interface LocalModelInfo extends JsonRecord {
  readonly id: string
  readonly kind: LocalModelKind
  readonly name: string
  readonly license: string
  readonly licenseUrl: string
  readonly input: ModelEndpointInput
  readonly totalBytes: number
  readonly install: LocalModelInstall
}

export const LOCAL_MODEL_RUNTIME = {
  stopped: "stopped",
  starting: "starting",
  running: "running",
  failed: "failed"
} as const

export type LocalModelRuntime =
  | {
      readonly state:
        | typeof LOCAL_MODEL_RUNTIME.stopped
        | typeof LOCAL_MODEL_RUNTIME.starting
        | typeof LOCAL_MODEL_RUNTIME.running
    }
  | { readonly state: typeof LOCAL_MODEL_RUNTIME.failed; readonly error: string }

export const LOCAL_MODELS_FREE_SPACE = { measured: "measured", unmeasured: "unmeasured" } as const

export type LocalModelsFreeSpace =
  | { readonly kind: typeof LOCAL_MODELS_FREE_SPACE.measured; readonly bytes: number }
  | { readonly kind: typeof LOCAL_MODELS_FREE_SPACE.unmeasured }

export interface LocalModelsStatus extends JsonRecord {
  readonly models: ReadonlyArray<LocalModelInfo>
  readonly freeSpace: LocalModelsFreeSpace
  readonly runtime: LocalModelRuntime
}
