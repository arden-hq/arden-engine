import { Schema } from "effect"
import {
  OFFERED_TOOLS,
  OPERATIONAL_SESSION,
  PREVIOUS_WRITE,
  RUN_EXECUTION,
  STREAM_MARK,
  daemonHandshake,
  type CliAccess,
  type ConfiguredServerReady,
  type OperationalEventMessage
} from "./contracts.js"
import {
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"

const CauseSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000))
const IdentifierSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const OperationalEventBaseFields = {
  version: Schema.Literal(1),
  occurredAt: IsoDateTimeStringSchema
}

const StreamMarkSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(STREAM_MARK.unseen) }),
  Schema.Struct({ kind: Schema.Literal(STREAM_MARK.seen), ms: NonNegativeIntSchema })
])

const PhaseOutcomeSchema = Schema.Literals(["completed", "failed", "cancelled", "interrupted"])

const LocalModelPhaseFields = {
  sampleId: IdentifierSchema,
  phase: Schema.Literals(["admission", "preparation", "compaction", "accounting", "checkpoint"]),
  outcome: PhaseOutcomeSchema,
  durationMs: NonNegativeIntSchema
}

const ProviderModelPhaseFields = {
  sampleId: IdentifierSchema,
  phase: Schema.Literal("provider"),
  outcome: PhaseOutcomeSchema,
  durationMs: NonNegativeIntSchema,
  consumerMs: NonNegativeIntSchema,
  firstItem: StreamMarkSchema,
  firstText: StreamMarkSchema,
  firstTool: StreamMarkSchema,
  retries: NonNegativeIntSchema,
  scheduledBackoffMs: NonNegativeIntSchema
}

export const ModelPhaseTimingSchema = Schema.Union([
  Schema.Struct(LocalModelPhaseFields),
  Schema.Struct(ProviderModelPhaseFields)
])

const ModelPhaseEventFields = {
  ...OperationalEventBaseFields,
  code: Schema.Literal("chat.model_phase"),
  severity: Schema.Literal("info"),
  runId: IdentifierSchema,
  sessionId: IdentifierSchema
}

const SchemaDriftFields = {
  ...OperationalEventBaseFields,
  code: Schema.Literal("storage.schema_drift"),
  objectType: IdentifierSchema,
  objectName: IdentifierSchema
}

const IdleCompactionFields = {
  ...OperationalEventBaseFields,
  code: Schema.Literal("context.idle_compaction"),
  severity: Schema.Literal("info"),
  sessionId: IdentifierSchema,
  reason: Schema.String
}

export const OperationalEventSchema = Schema.Union([
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("chat.agent_run_timing"),
    severity: Schema.Literal("info"),
    runId: IdentifierSchema,
    sessionId: IdentifierSchema,
    waitMs: NonNegativeIntSchema,
    execution: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(RUN_EXECUTION.neverAcquired) }),
      Schema.Struct({ kind: Schema.Literal(RUN_EXECUTION.acquired), ms: NonNegativeIntSchema })
    ]),
    outcome: Schema.Literals(["completed", "failed", "interrupted"] as const)
  }),
  Schema.Struct({ ...ModelPhaseEventFields, ...LocalModelPhaseFields }),
  Schema.Struct({ ...ModelPhaseEventFields, ...ProviderModelPhaseFields }),
  Schema.Struct({
    ...SchemaDriftFields,
    severity: Schema.Literal("warning"),
    verdict: Schema.Literal("foreign_warning")
  }),
  Schema.Struct({
    ...SchemaDriftFields,
    severity: Schema.Literal("error"),
    verdict: Schema.Literal("owned_fatal"),
    cause: CauseSchema
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("delivery.retry_scheduled"),
    severity: Schema.Literal("warning"),
    cause: CauseSchema,
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
    cause: CauseSchema,
    deliveryId: IdentifierSchema,
    sourceRunId: IdentifierSchema,
    attempt: NonNegativeIntSchema,
    incidentId: IdentifierSchema
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("automation.firing_deferred"),
    severity: Schema.Literal("info"),
    cause: CauseSchema,
    automationTaskId: IdentifierSchema,
    automationRunId: PositiveIntSchema,
    queueId: PositiveIntSchema,
    session: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(OPERATIONAL_SESSION.none) }),
      Schema.Struct({
        kind: Schema.Literal(OPERATIONAL_SESSION.session),
        sessionId: IdentifierSchema
      })
    ]),
    nextAttemptAt: IsoDateTimeStringSchema
  }),
  Schema.Struct({
    ...IdleCompactionFields,
    decision: Schema.Literals(["queued", "skipped", "ran"] as const)
  }),
  Schema.Struct({
    ...IdleCompactionFields,
    decision: Schema.Literal("failed"),
    cause: CauseSchema
  }),
  Schema.Struct({
    ...OperationalEventBaseFields,
    code: Schema.Literal("storage.write_wait"),
    severity: Schema.Literal("warning"),
    lane: Schema.Literals(["interactive", "ordinary"] as const),
    operation: Schema.String,
    previous: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(PREVIOUS_WRITE.none) }),
      Schema.Struct({ kind: Schema.Literal(PREVIOUS_WRITE.operation), operation: Schema.String })
    ]),
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

const PathSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))
const NamesSchema = Schema.Array(Schema.String.check(Schema.isMinLength(1)))

export const ConfiguredServerReadySchema: Schema.Codec<ConfiguredServerReady> = Schema.Struct({
  type: Schema.Literal("ready"),
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
  dataDirectory: PathSchema,
  accessFile: PathSchema,
  usageFile: PathSchema,
  offeredTools: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(OFFERED_TOOLS.all) }),
    Schema.Struct({ kind: Schema.Literal(OFFERED_TOOLS.listed), names: NamesSchema })
  ]),
  toolsWithoutRule: NamesSchema,
  mcpServers: NamesSchema,
  provider: IdentifierSchema,
  model: IdentifierSchema,
  contextWindow: PositiveIntSchema
})
