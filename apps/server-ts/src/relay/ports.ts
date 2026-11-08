import type { CommandKind } from "@arden-hq/relay-protocol"
import type { Schema } from "effect"
import type {
  PairedDevice,
  PushTarget,
  RelayCommandRecord,
  RelayCommandState
} from "../persistence/relay/store.js"
import type { SseFrame } from "@arden-hq/protocol"

export interface LoopbackResponse {
  readonly status: number
  readonly body: Schema.Json
}

export interface Loopback {
  readonly request: (input: {
    readonly method: "GET" | "POST"
    readonly path: string
    readonly body?: Schema.Json
    readonly signal?: AbortSignal
  }) => Promise<LoopbackResponse>
  readonly events: (input: {
    readonly path: string
    readonly lastEventId: string | undefined
    readonly signal: AbortSignal
  }) => AsyncIterable<Pick<SseFrame, "id" | "data">>
}

export interface CommandLog {
  readonly find: (cid: string) => Promise<RelayCommandRecord | undefined>
  readonly begin: (input: {
    readonly cid: string
    readonly kind: CommandKind
  }) => Promise<RelayCommandRecord | undefined>
  readonly finish: (input: {
    readonly cid: string
    readonly state: Exclude<RelayCommandState, "running">
    readonly result: Schema.Json | undefined
  }) => Promise<void>
}

export interface DeviceRegistry {
  readonly list: () => Promise<ReadonlyArray<PairedDevice>>
  readonly add: (
    device: Omit<PairedDevice, "addedAt" | "lastSeenAt" | "push">
  ) => Promise<PairedDevice>
  readonly revoke: (dev: string) => Promise<boolean>
  readonly seen: (dev: string, at: Date) => Promise<void>
  readonly setPush: (dev: string, push: PushTarget | undefined) => Promise<void>
}

export type RelayLog = (
  level: "info" | "warning",
  message: string,
  fields?: Readonly<Record<string, string | number | boolean>>
) => void
