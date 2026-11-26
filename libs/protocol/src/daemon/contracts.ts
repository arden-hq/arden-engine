import type { JsonRecord } from "../common/json.js"

export const daemonHandshake = {
  daemonVersion: "1.0.0",
  protocolVersion: 1,
  schemaVersion: 1,
  capabilities: {
    httpApi: true,
    sessionEvents: true,
    automationEvents: true
  }
} as const

export const SERVER_BOOT_HEADER = "x-arden-boot"

export interface DaemonClientHandshake extends JsonRecord {
  readonly protocolVersion: typeof daemonHandshake.protocolVersion
  readonly schemaVersion: typeof daemonHandshake.schemaVersion
}

export interface DaemonReadyMessage extends JsonRecord {
  readonly type: "ready"
  readonly appVersion: string
  readonly daemonVersion: typeof daemonHandshake.daemonVersion
  readonly protocolVersion: typeof daemonHandshake.protocolVersion
  readonly schemaVersion: typeof daemonHandshake.schemaVersion
  readonly capabilities: typeof daemonHandshake.capabilities
  readonly hostname: "127.0.0.1"
  readonly port: number
  readonly serverUrl: string
}

interface OperationalEventBase extends JsonRecord {
  readonly version: 1
  readonly occurredAt: string
}

export type SchemaDriftOperationalEvent = OperationalEventBase & {
  readonly code: "storage.schema_drift"
  readonly objectType: string
  readonly objectName: string
} & (
    | { readonly severity: "warning"; readonly verdict: "foreign_warning" }
    | { readonly severity: "error"; readonly verdict: "owned_fatal"; readonly cause: string }
  )

export interface DeliveryRetryScheduledOperationalEvent extends OperationalEventBase {
  readonly code: "delivery.retry_scheduled"
  readonly severity: "warning"
  readonly cause: string
  readonly deliveryId: string
  readonly sourceRunId: string
  readonly destinationSessionId: string
  readonly attempt: number
  readonly nextAttemptAt: string
}

export interface DeliveryReroutedOperationalEvent extends OperationalEventBase {
  readonly code: "delivery.rerouted"
  readonly severity: "info"
  readonly deliveryId: string
  readonly sourceRunId: string
  readonly fromSessionId: string
  readonly toSessionId: string
  readonly attempt: number
}

export interface DeliveryUnroutableOperationalEvent extends OperationalEventBase {
  readonly code: "delivery.unroutable"
  readonly severity: "error"
  readonly cause: string
  readonly deliveryId: string
  readonly sourceRunId: string
  readonly attempt: number
  readonly incidentId: string
}

export const OPERATIONAL_SESSION = { none: "none", session: "session" } as const

export interface AutomationFiringDeferredOperationalEvent extends OperationalEventBase {
  readonly code: "automation.firing_deferred"
  readonly severity: "info"
  readonly cause: string
  readonly automationTaskId: string
  readonly automationRunId: number
  readonly queueId: number
  readonly session:
    | { readonly kind: "none" }
    | { readonly kind: "session"; readonly sessionId: string }
  readonly nextAttemptAt: string
}

export type ContextIdleCompactionOperationalEvent = OperationalEventBase & {
  readonly code: "context.idle_compaction"
  readonly severity: "info"
  readonly sessionId: string
  readonly reason: string
} & (
    | { readonly decision: "queued" | "skipped" | "ran" }
    | { readonly decision: "failed"; readonly cause: string }
  )

export const PREVIOUS_WRITE = { none: "none", operation: "operation" } as const

export interface StorageWriteWaitOperationalEvent extends OperationalEventBase {
  readonly code: "storage.write_wait"
  readonly severity: "warning"
  readonly lane: "interactive" | "ordinary"
  readonly operation: string
  readonly previous:
    | { readonly kind: "none" }
    | { readonly kind: "operation"; readonly operation: string }
  readonly waitMs: number
  readonly queued: number
}

export interface StorageWriteSlowOperationalEvent extends OperationalEventBase {
  readonly code: "storage.write_slow"
  readonly severity: "warning"
  readonly lane: "interactive" | "ordinary"
  readonly operation: string
  readonly durationMs: number
}

export interface EventLoopStallOperationalEvent extends OperationalEventBase {
  readonly code: "runtime.event_loop_stall"
  readonly severity: "warning"
  readonly stallMs: number
}

export const RUN_EXECUTION = { neverAcquired: "never_acquired", acquired: "acquired" } as const

export interface AgentRunTimingOperationalEvent extends OperationalEventBase {
  readonly code: "chat.agent_run_timing"
  readonly severity: "info"
  readonly runId: string
  readonly sessionId: string
  readonly waitMs: number
  readonly execution:
    | { readonly kind: "never_acquired" }
    | { readonly kind: "acquired"; readonly ms: number }
  readonly outcome: "completed" | "failed" | "interrupted"
}

export const STREAM_MARK = { unseen: "unseen", seen: "seen" } as const

export type StreamMark =
  | { readonly kind: "unseen" }
  | { readonly kind: "seen"; readonly ms: number }

interface ModelPhaseTimingBase extends JsonRecord {
  readonly sampleId: string
  readonly outcome: "completed" | "failed" | "cancelled" | "interrupted"
  readonly durationMs: number
}

export interface LocalModelPhaseTiming extends ModelPhaseTimingBase {
  readonly phase: "admission" | "preparation" | "compaction" | "accounting" | "checkpoint"
}

export interface ProviderModelPhaseTiming extends ModelPhaseTimingBase {
  readonly phase: "provider"
  readonly consumerMs: number
  readonly firstItem: StreamMark
  readonly firstText: StreamMark
  readonly firstTool: StreamMark
  readonly retries: number
  readonly scheduledBackoffMs: number
}

export type ModelPhaseTiming = LocalModelPhaseTiming | ProviderModelPhaseTiming

type ModelPhaseOperationalEvent = OperationalEventBase &
  ModelPhaseTiming & {
    readonly code: "chat.model_phase"
    readonly severity: "info"
    readonly runId: string
    readonly sessionId: string
  }

export type OperationalEvent =
  | SchemaDriftOperationalEvent
  | DeliveryRetryScheduledOperationalEvent
  | DeliveryReroutedOperationalEvent
  | DeliveryUnroutableOperationalEvent
  | AutomationFiringDeferredOperationalEvent
  | ContextIdleCompactionOperationalEvent
  | StorageWriteWaitOperationalEvent
  | StorageWriteSlowOperationalEvent
  | EventLoopStallOperationalEvent
  | AgentRunTimingOperationalEvent
  | ModelPhaseOperationalEvent

export interface OperationalEventMessage extends JsonRecord {
  readonly type: "operational_event"
  readonly event: OperationalEvent
}

export const LOCAL_CAPABILITY_HEADER = "x-arden-local-capability"

export const CLI_ACCESS_FILE = "cli-access.json"

export interface CliAccess extends JsonRecord {
  readonly version: 1
  readonly serverUrl: string
  readonly capability: string
  readonly pid: number
}

export const CONFIGURED_SERVER_EXIT = { settings: 2, providerUnreachable: 3 } as const

export const OFFERED_TOOLS = { all: "all", listed: "listed" } as const

export type OfferedTools =
  | { readonly kind: "all" }
  | { readonly kind: "listed"; readonly names: ReadonlyArray<string> }

export interface ConfiguredServerReady extends JsonRecord {
  readonly type: "ready"
  readonly url: string
  readonly dataDirectory: string
  readonly accessFile: string
  readonly usageFile: string
  readonly offeredTools: OfferedTools
  readonly toolsWithoutRule: ReadonlyArray<string>
  readonly mcpServers: ReadonlyArray<string>
  readonly provider: string
  readonly model: string
  readonly contextWindow: number
}
