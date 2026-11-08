import type { ModelPhaseTiming, OperationalEvent } from "@arden-hq/protocol/daemon"
import { redactedFailureText } from "@arden-hq/std/errors"
import { Cause } from "effect"

export type OperationalEventInput =
  | {
      readonly code: "chat.agent_run_timing"
      readonly severity: "info"
      readonly cause: null
      readonly runId: string
      readonly sessionId: string
      readonly waitMs: number
      readonly executionMs: number | null
      readonly outcome: "completed" | "failed" | "interrupted"
    }
  | (ModelPhaseTiming & {
      readonly code: "chat.model_phase"
      readonly severity: "info"
      readonly cause: null
      readonly runId: string
      readonly sessionId: string
    })
  | {
      readonly code: "storage.schema_drift"
      readonly severity: "warning" | "error"
      readonly cause: string | null
      readonly objectType: string
      readonly objectName: string
      readonly verdict: "foreign_warning" | "owned_fatal"
    }
  | {
      readonly code: "delivery.retry_scheduled"
      readonly severity: "warning"
      readonly cause: string | null
      readonly deliveryId: string
      readonly sourceRunId: string
      readonly destinationSessionId: string
      readonly attempt: number
      readonly nextAttemptAt: string
    }
  | {
      readonly code: "context.idle_compaction"
      readonly severity: "info"
      readonly cause: string | null
      readonly sessionId: string
      readonly decision: "queued" | "skipped" | "ran" | "failed"
      readonly reason: string
    }
  | {
      readonly code: "storage.write_wait"
      readonly severity: "warning"
      readonly cause: null
      readonly lane: "interactive" | "ordinary"
      readonly operation: string
      readonly previousOperation: string | null
      readonly waitMs: number
      readonly queued: number
    }
  | {
      readonly code: "storage.write_slow"
      readonly severity: "warning"
      readonly cause: null
      readonly lane: "interactive" | "ordinary"
      readonly operation: string
      readonly durationMs: number
    }
  | {
      readonly code: "runtime.event_loop_stall"
      readonly severity: "warning"
      readonly cause: null
      readonly stallMs: number
    }
  | {
      readonly code: "delivery.rerouted"
      readonly severity: "info"
      readonly cause: string | null
      readonly deliveryId: string
      readonly sourceRunId: string
      readonly fromSessionId: string
      readonly toSessionId: string
      readonly attempt: number
    }
  | {
      readonly code: "delivery.unroutable"
      readonly severity: "error"
      readonly cause: string | null
      readonly deliveryId: string
      readonly sourceRunId: string
      readonly attempt: number
      readonly incidentId: string
    }
  | {
      readonly code: "automation.firing_deferred"
      readonly severity: "info"
      readonly cause: string | null
      readonly automationTaskId: string
      readonly automationRunId: number
      readonly queueId: number
      readonly sessionId: string | null
      readonly nextAttemptAt: string
    }

export const serializeOperationalCause = (cause: unknown): string | null => {
  if (cause === undefined || cause === null) return null
  let rendered: string
  if (Cause.isCause(cause)) rendered = Cause.pretty(cause)
  else if (cause instanceof Error) rendered = `${cause.name}: ${cause.message}`
  else rendered = String(cause)
  const normalized = redactedFailureText(rendered)
  return normalized.length === 0 ? "Unknown failure" : normalized
}

export const operationalEvent = (
  input: OperationalEventInput,
  occurredAt: string
): OperationalEvent => {
  switch (input.code) {
    case "chat.agent_run_timing":
    case "chat.model_phase":
    case "storage.schema_drift":
    case "delivery.retry_scheduled":
    case "delivery.rerouted":
    case "delivery.unroutable":
    case "automation.firing_deferred":
    case "context.idle_compaction":
    case "storage.write_wait":
    case "storage.write_slow":
    case "runtime.event_loop_stall":
      return {
        ...input,
        version: 1,
        occurredAt,
        cause: serializeOperationalCause(input.cause)
      }
  }
}
