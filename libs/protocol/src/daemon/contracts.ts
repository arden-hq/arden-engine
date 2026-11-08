import type { JsonRecord } from "../common/json.js"

/** Compatibility numbers between the desktop and its server, not product versions:
 *  the product version is apps/desktop/package.json (see docs/releasing.md). */
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

/**
 * The response header naming the server boot that answered: one random ID per
 * server start, on every HTTP response and every event stream. A client that
 * sees a different ID knows the server started over from what it recovered,
 * so every read it holds from the last boot is stale.
 */
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
  readonly cause: string | null
}

export interface SchemaDriftOperationalEvent extends OperationalEventBase {
  readonly code: "storage.schema_drift"
  readonly severity: "warning" | "error"
  readonly objectType: string
  readonly objectName: string
  readonly verdict: "foreign_warning" | "owned_fatal"
}

export interface DeliveryRetryScheduledOperationalEvent extends OperationalEventBase {
  readonly code: "delivery.retry_scheduled"
  readonly severity: "warning"
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
  readonly deliveryId: string
  readonly sourceRunId: string
  readonly attempt: number
  readonly incidentId: string
}

export interface AutomationFiringDeferredOperationalEvent extends OperationalEventBase {
  readonly code: "automation.firing_deferred"
  readonly severity: "info"
  readonly automationTaskId: string
  readonly automationRunId: number
  readonly queueId: number
  /** Null when the job was held back on a plan limit before it started a Run. */
  readonly sessionId: string | null
  readonly nextAttemptAt: string
}

/** One decision about compacting an idle chat: queued, dropped, ran or failed, with its reason. */
export interface ContextIdleCompactionOperationalEvent extends OperationalEventBase {
  readonly code: "context.idle_compaction"
  readonly severity: "info"
  readonly sessionId: string
  readonly decision: "queued" | "skipped" | "ran" | "failed"
  readonly reason: string
}

/** A write sat in the persistence queue this long before it ran. */
export interface StorageWriteWaitOperationalEvent extends OperationalEventBase {
  readonly code: "storage.write_wait"
  readonly severity: "warning"
  readonly lane: "interactive" | "ordinary"
  readonly operation: string
  readonly previousOperation: string | null
  readonly waitMs: number
  /** Writes still queued in both lanes when this one started. */
  readonly queued: number
}

/** Execution time for an operation that held the serialized writer. */
export interface StorageWriteSlowOperationalEvent extends OperationalEventBase {
  readonly code: "storage.write_slow"
  readonly severity: "warning"
  readonly lane: "interactive" | "ordinary"
  readonly operation: string
  readonly durationMs: number
}

/** The event loop ran this much later than scheduled: nothing else could run meanwhile. */
export interface EventLoopStallOperationalEvent extends OperationalEventBase {
  readonly code: "runtime.event_loop_stall"
  readonly severity: "warning"
  readonly stallMs: number
}

/** Time before a Run acquired its agent-tree permit, and time after acquisition. */
export interface AgentRunTimingOperationalEvent extends OperationalEventBase {
  readonly code: "chat.agent_run_timing"
  readonly severity: "info"
  readonly runId: string
  readonly sessionId: string
  readonly waitMs: number
  /** Null when cancelled before acquiring a permit. */
  readonly executionMs: number | null
  readonly outcome: "completed" | "failed" | "interrupted"
}

/** Monotonic timings. First-item offsets refer to mapped provider items, not network bytes. */
export interface ModelPhaseTiming extends JsonRecord {
  readonly sampleId: string
  readonly phase:
    | "admission"
    | "preparation"
    | "compaction"
    | "provider"
    | "accounting"
    | "checkpoint"
  readonly outcome: "completed" | "failed" | "cancelled" | "interrupted"
  readonly durationMs: number
  /** Time the stream was suspended while Loop consumed its items; included in durationMs. */
  readonly consumerMs: number
  readonly firstItemMs: number | null
  readonly firstTextMs: number | null
  readonly firstToolMs: number | null
  readonly retries: number
  /** Advertised retry delays, not a measurement of actual sleep. */
  readonly scheduledBackoffMs: number
}

interface ModelPhaseOperationalEvent extends OperationalEventBase, ModelPhaseTiming {
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

/** The request header carrying the desktop host's grant (http/middleware/local-only.ts). */
export const LOCAL_CAPABILITY_HEADER = "x-arden-local-capability"

/**
 * The file, in the Arden data folder, that tells a command-line client where
 * the running daemon listens and which capability to send. The daemon writes
 * it (owner-only) once it listens and removes it when it stops; a file left by
 * a crash names a server that no longer answers.
 */
export const CLI_ACCESS_FILE = "cli-access.json"

export interface CliAccess extends JsonRecord {
  readonly version: 1
  readonly serverUrl: string
  readonly capability: string
  readonly pid: number
}
