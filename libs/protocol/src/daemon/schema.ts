import { Schema } from "effect"
import { daemonHandshake, type CliAccess, type OperationalEventMessage } from "./contracts.js"
import {
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"

const CauseSchema = Schema.NullOr(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000))
)
const IdentifierSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const OperationalEventBaseFields = {
  version: Schema.Literal(1),
  occurredAt: IsoDateTimeStringSchema,
  cause: CauseSchema
}

export const ModelPhaseTimingSchema = Schema.Struct({
  sampleId: IdentifierSchema,
  phase: Schema.Literals([
    "admission",
    "preparation",
    "compaction",
    "provider",
    "accounting",
    "checkpoint"
  ]),
  outcome: Schema.Literals(["completed", "failed", "cancelled", "interrupted"]),
  durationMs: NonNegativeIntSchema,
  consumerMs: NonNegativeIntSchema,
  firstItemMs: Schema.NullOr(NonNegativeIntSchema),
  firstTextMs: Schema.NullOr(NonNegativeIntSchema),
  firstToolMs: Schema.NullOr(NonNegativeIntSchema),
  retries: NonNegativeIntSchema,
  scheduledBackoffMs: NonNegativeIntSchema
})

export const OperationalEventSchema = Schema.Union([
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("chat.agent_run_timing"),
    severity: Schema.Literal("info"),
    runId: IdentifierSchema,
    sessionId: IdentifierSchema,
    waitMs: NonNegativeIntSchema,
    executionMs: Schema.NullOr(NonNegativeIntSchema),
    outcome: Schema.Literals(["completed", "failed", "interrupted"] as const)
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("chat.model_phase"),
    severity: Schema.Literal("info"),
    runId: IdentifierSchema,
    sessionId: IdentifierSchema,
    ...ModelPhaseTimingSchema.fields
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("storage.schema_drift"),
    severity: Schema.Literals(["warning", "error"] as const),
    objectType: IdentifierSchema,
    objectName: IdentifierSchema,
    verdict: Schema.Literals(["foreign_warning", "owned_fatal"] as const)
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("delivery.retry_scheduled"),
    severity: Schema.Literal("warning"),
    deliveryId: IdentifierSchema,
    sourceRunId: IdentifierSchema,
    destinationSessionId: IdentifierSchema,
    attempt: PositiveIntSchema,
    nextAttemptAt: IsoDateTimeStringSchema
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("delivery.rerouted"),
    severity: Schema.Literal("info"),
    deliveryId: IdentifierSchema,
    sourceRunId: IdentifierSchema,
    fromSessionId: IdentifierSchema,
    toSessionId: IdentifierSchema,
    attempt: NonNegativeIntSchema
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("delivery.unroutable"),
    severity: Schema.Literal("error"),
    deliveryId: IdentifierSchema,
    sourceRunId: IdentifierSchema,
    attempt: NonNegativeIntSchema,
    incidentId: IdentifierSchema
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("automation.firing_deferred"),
    severity: Schema.Literal("info"),
    automationTaskId: IdentifierSchema,
    automationRunId: PositiveIntSchema,
    queueId: PositiveIntSchema,
    sessionId: Schema.NullOr(IdentifierSchema),
    nextAttemptAt: IsoDateTimeStringSchema
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("context.idle_compaction"),
    severity: Schema.Literal("info"),
    sessionId: IdentifierSchema,
    decision: Schema.Literals(["queued", "skipped", "ran", "failed"] as const),
    reason: Schema.String
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("storage.write_wait"),
    severity: Schema.Literal("warning"),
    lane: Schema.Literals(["interactive", "ordinary"] as const),
    operation: Schema.String,
    previousOperation: Schema.NullOr(Schema.String),
    waitMs: NonNegativeIntSchema,
    queued: NonNegativeIntSchema
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("storage.write_slow"),
    severity: Schema.Literal("warning"),
    lane: Schema.Literals(["interactive", "ordinary"] as const),
    operation: Schema.String,
    durationMs: NonNegativeIntSchema
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("runtime.event_loop_stall"),
    severity: Schema.Literal("warning"),
    stallMs: NonNegativeIntSchema
  })
])

export const OperationalEventMessageSchema: Schema.Codec<OperationalEventMessage> = Schema.Struct({
  type: Schema.Literal("operational_event"),
  event: OperationalEventSchema
})

export const DaemonClientHandshakeSchema = Schema.Struct({
  protocolVersion: Schema.Literal(daemonHandshake.protocolVersion),
  schemaVersion: Schema.Literal(daemonHandshake.schemaVersion)
})

export const DaemonReadyMessageSchema = Schema.Struct({
  type: Schema.Literal("ready"),
  appVersion: Schema.String.check(Schema.isMinLength(1)),
  daemonVersion: Schema.Literal(daemonHandshake.daemonVersion),
  protocolVersion: Schema.Literal(daemonHandshake.protocolVersion),
  schemaVersion: Schema.Literal(daemonHandshake.schemaVersion),
  capabilities: Schema.Struct({
    httpApi: Schema.Literal(daemonHandshake.capabilities.httpApi),
    sessionEvents: Schema.Literal(daemonHandshake.capabilities.sessionEvents),
    automationEvents: Schema.Literal(daemonHandshake.capabilities.automationEvents)
  }),
  hostname: Schema.Literal("127.0.0.1"),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  serverUrl: Schema.String.check(Schema.isMinLength(1))
})

export const CliAccessSchema: Schema.Codec<CliAccess> = Schema.Struct({
  version: Schema.Literal(1),
  serverUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
  capability: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
  pid: PositiveIntSchema
})
