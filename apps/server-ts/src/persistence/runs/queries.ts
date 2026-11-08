import type { RunProgress } from "@arden-hq/protocol/runs"
import type { GoogleServiceId } from "@arden-hq/protocol/google"
import { ActiveRunStatusSchema } from "@arden-hq/protocol/effect/chat"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { Context, Effect, Schema } from "effect"
import type { EndingRecord } from "./ending.js"
import type { ChatRunRecord } from "./model.js"
import type { RunAuthority } from "../../execution/authority.js"
import type { RunLiveness } from "./liveness.js"

export const ActiveRunSnapshotSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  turnId: Schema.NonEmptyString,
  status: ActiveRunStatusSchema,
  startedAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  messageCount: Schema.Natural,
  pendingInjections: Schema.Natural,
  approvalsPending: Schema.Natural
})

export type ActiveRunSnapshot = (typeof ActiveRunSnapshotSchema)["Type"]

export interface ActiveRunsSnapshot {
  readonly totalRetained: number
  readonly runs: ReadonlyArray<ActiveRunSnapshot>
}

interface RunEventRecord {
  readonly sequence: number
  readonly createdAt: string
  readonly event: ChatProjectionEvent
}

export interface RunEventPageRecord {
  readonly runId: string
  readonly sessionId: string
  readonly traceRemovedAt: string | null
  readonly events: ReadonlyArray<RunEventRecord>
  readonly nextAfterSequence: number
  readonly hasMore: boolean
}

export interface RunEventPageInput {
  readonly runId: string
  readonly afterSequence: number
  readonly limit: number
}

export class RunQueryError extends Schema.TaggedError<RunQueryError>()("RunQueryError", {
  reason: Schema.tag("storage"),
  operation: Schema.Literals([
    "get",
    "latest_for_session",
    "current_for_sessions",
    "ending",
    "active",
    "events",
    "google_accounts",
    "progress",
    "plan_limit_pauses",
    "chat_work",
    "output_turns"
  ] as const),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class RunDataCorruptionError extends Schema.TaggedError<RunDataCorruptionError>()(
  "RunDataCorruptionError",
  {
    reason: Schema.tag("corrupt"),
    runId: Schema.NonEmptyString,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export type RunQueryFailure = RunQueryError | RunDataCorruptionError

export interface PlanLimitPausedRun {
  readonly runId: string
  readonly sessionId: string
  readonly reason: string
  readonly until: string
  readonly automationId: string | null
}

export interface RunCause {
  readonly automationId: string | undefined
  readonly wakeDepth: number
}

export type ChatWorkRunKind = "reply" | "agent" | "automation"

export interface ChatWork {
  readonly sessionIds: ReadonlyArray<string>
  readonly runs: ReadonlyArray<{ readonly runId: string; readonly kind: ChatWorkRunKind }>
  readonly workflows: ReadonlyArray<string>
}

export interface SessionRunReference {
  readonly current: Pick<ChatRunRecord, "runId" | "status">
  readonly latestEnding:
    | Pick<EndingRecord, "runId" | "status" | "detail" | "occurredAt">
    | undefined
}

export class RunQueries extends Context.Service<
  RunQueries,
  {
    readonly progress: (runId: string) => Effect.Effect<RunProgress | null, RunQueryFailure>
    readonly waitingToolCalls: (
      runId: string
    ) => Effect.Effect<ReadonlyArray<string>, RunQueryFailure>
    readonly googleAccounts: (
      runId: string,
      service: GoogleServiceId
    ) => Effect.Effect<ReadonlyArray<string> | null, RunQueryError>
    readonly get: (runId: string) => Effect.Effect<ChatRunRecord | null, RunQueryFailure>
    readonly sessionId: (runId: string) => Effect.Effect<string | undefined, RunQueryError>
    readonly turnsOfRuns: (
      runIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyMap<string, string>, RunQueryError>
    readonly cause: (runId: string) => Effect.Effect<RunCause, RunQueryError>
    readonly liveness: (runId: string) => Effect.Effect<RunLiveness | undefined, RunQueryError>
    readonly authority: (runId: string) => Effect.Effect<RunAuthority | undefined, RunQueryError>
    readonly latestForSession: (
      sessionId: string
    ) => Effect.Effect<ChatRunRecord | null, RunQueryFailure>
    readonly currentForSessions: (
      sessionIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyMap<string, SessionRunReference>, RunQueryFailure>
    readonly ending: (runId: string) => Effect.Effect<EndingRecord | undefined, RunQueryFailure>
    readonly active: (
      runId: string
    ) => Effect.Effect<ActiveRunSnapshot | undefined, RunQueryFailure>
    readonly listActive: () => Effect.Effect<ActiveRunsSnapshot, RunQueryFailure>
    readonly chatWork: (sessionId: string) => Effect.Effect<ChatWork, RunQueryError>
    readonly planLimitPauses: () => Effect.Effect<ReadonlyArray<PlanLimitPausedRun>, RunQueryError>
    readonly events: (
      input: RunEventPageInput
    ) => Effect.Effect<RunEventPageRecord | null, RunQueryFailure>
  }
>()("@arden-hq/server/persistence/runs/RunQueries") {}
