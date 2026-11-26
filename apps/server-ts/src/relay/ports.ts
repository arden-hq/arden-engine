import type { CommandAckState, CommandKind } from "@arden-hq/relay-protocol"
import type { Schema } from "effect"
import type { PairedDevice, PushTarget, RelayCommandRecord } from "../persistence/relay/store.js"
import type { SseFrame, SseFrameId } from "@arden-hq/protocol"

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
    readonly lastEventId: SseFrameId
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
    readonly state: CommandAckState
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

const RELAY_LOG_LEVEL = { info: "info", warning: "warning" } as const

export type RelayLogLevel = (typeof RELAY_LOG_LEVEL)[keyof typeof RELAY_LOG_LEVEL]

export type RelayLog = (
  level: RelayLogLevel,
  message: string,
  fields?: Readonly<Record<string, string | number | boolean>>
) => void
