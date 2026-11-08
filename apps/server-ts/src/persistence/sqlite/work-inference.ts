import { assertCurrentTaskRevision } from "./work-history.js"
import type { SpaceTaskSource } from "@arden-hq/protocol/spaces/work"
import { SpaceTaskSourceSchema } from "@arden-hq/protocol/effect/spaces/work"
import { TaskInferencePolicySchema } from "@arden-hq/protocol/effect/spaces"
import { Effect, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import type { TaskInferenceReview } from "../work/inference.js"
import { WorkStoreError } from "../work/store.js"
import { workError } from "./work-records.js"
import { decodeJson } from "./json.js"
import { assertInferenceNotRejected } from "./work-inference-rejections.js"
import { runMayActSql } from "./run-liveness.js"
import { openProposalStatusList } from "./status-sets.js"
import {
  readChatSettled,
  readSessionSettled,
  settledFingerprint,
  type ChatSettledState
} from "./chat-ownership.js"
import { assertItemEvidence } from "./connection-item-evidence.js"
import { assertHomeProposalRoom, assertOpenProposalRoom } from "./proposal-room.js"
import { sha256Hex } from "@arden-hq/std/hash"

export const readInferenceReview = Effect.fn("Work.inferenceReview")(function* (
  read: {
    readonly sql: SqlClient.SqlClient
    readonly consistent: <A, E>(
      read: Effect.Effect<A, E>
    ) => Effect.Effect<A, E | SqlError.SqlError>
  },
  spaceId: string
): Effect.fn.Return<TaskInferenceReview, WorkStoreError> {
  const { sql } = read
  return yield* read
    .consistent(
      Effect.gen(function* () {
        const tasks = yield* sql<
          TaskInferenceReview["tasks"][number]
        >`SELECT item_id, text, status, updated_at
      FROM space_tasks WHERE space_id = ${spaceId} ORDER BY item_id LIMIT 1001`
        const chats = yield* readChatSettled(sql, spaceId)
        const proposalRows = yield* sql<{
          readonly proposal_id: string
          readonly text: string
          readonly body: string | null
          readonly revision: number
          readonly status: string
          readonly sources_json: string
        }>`SELECT proposal_id, text, body, revision, status, sources_json FROM task_proposals
          WHERE space_id = ${spaceId} AND status IN ${openProposalStatusList}
          ORDER BY proposal_id LIMIT 1001`
        const proposals = yield* Effect.forEach(proposalRows, ({ sources_json, ...row }) =>
          decodeJson(Schema.Array(SpaceTaskSourceSchema), sources_json).pipe(
            Effect.map((sources) => ({ ...row, sources }))
          )
        )
        const rejectedTasks = yield* sql<{
          readonly item_id: string
          readonly sources: string
          readonly reason: string
        }>`
      SELECT item_id, sources, reason FROM task_inference_rejections WHERE space_id = ${spaceId} ORDER BY item_id LIMIT 1001`
        const rejectedProposals = yield* sql<{
          readonly proposal_id: string
          readonly sources: string
          readonly reason: string
        }>`SELECT proposal_id, sources_json AS sources,
      json_extract(capture_json, '$.reason') AS reason
      FROM task_proposals
      WHERE space_id = ${spaceId} AND status = 'rejected'
      ORDER BY proposal_id LIMIT 1001`
        const stoppedTasks = yield* sql<{
          readonly proposal_id: string
          readonly item_id: string
          readonly sources: string
          readonly reason: string
        }>`SELECT proposal.proposal_id, proposal.item_id, proposal.sources_json AS sources,
      json_extract(proposal.capture_json, '$.reason') AS reason
      FROM task_proposals AS proposal JOIN space_tasks AS task ON task.item_id = proposal.item_id
      WHERE proposal.space_id = ${spaceId} AND proposal.status = 'accepted'
        AND task.status = 'cancelled'
      ORDER BY proposal.proposal_id LIMIT 1001`
        if (
          tasks.length > 1000 ||
          proposals.length > 1000 ||
          rejectedTasks.length + rejectedProposals.length + stoppedTasks.length > 1000
        ) {
          return yield* workError(
            "conflict",
            "This Space exceeds the inference review window; automatic capture is paused until its complete history can be reviewed"
          )
        }
        const rejections = yield* Effect.forEach(
          [
            ...rejectedTasks.map((row) => ({
              kind: "task_undo" as const,
              item_id: row.item_id,
              proposal_id: null,
              sources: row.sources,
              reason: row.reason
            })),
            ...rejectedProposals.map((row) => ({
              kind: "proposal" as const,
              item_id: null,
              proposal_id: row.proposal_id,
              sources: row.sources,
              reason: row.reason
            })),
            ...stoppedTasks.map((row) => ({
              kind: "stopped_task" as const,
              item_id: row.item_id,
              proposal_id: row.proposal_id,
              sources: row.sources,
              reason: row.reason
            }))
          ],
          (row) =>
            decodeJson(Schema.Array(SpaceTaskSourceSchema), row.sources).pipe(
              Effect.map((sources) => ({ ...row, sources }))
            )
        )
        const snapshot = sha256Hex(
          JSON.stringify({
            tasks,
            rejections,
            chats: settledFingerprint(chats),
            proposals: proposals.map(({ proposal_id, revision, status }) => ({
              proposal_id,
              revision,
              status
            }))
          })
        )
        return { snapshot, tasks, rejections, chats, proposals }
      })
    )
    .pipe(
      Effect.mapError((cause) =>
        cause instanceof WorkStoreError
          ? cause
          : workError("storage", "Could not review inferred work", cause)
      )
    )
})

export const assertInferenceAdmission = Effect.fn("Work.admitInference")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly spaceId: string
    readonly runId: string
    readonly snapshot: string
    readonly sources: ReadonlyArray<SpaceTaskSource>
    readonly proposalId?: string
  }
): Effect.fn.Return<void, WorkStoreError> {
  yield* Effect.gen(function* () {
    const rows = yield* sql<{
      readonly inference_policy: string
      readonly captured_inference: string
      readonly origin_task: string | null
    }>`SELECT space.inference_policy,
      json_extract(run.metadata_json, '$.run_policy.space.inference') AS captured_inference,
      CASE WHEN json_extract(run.metadata_json, '$.run_context.origin.kind') = 'task'
        THEN json_extract(run.metadata_json, '$.run_context.origin.item_id') END AS origin_task
      FROM spaces AS space
      JOIN chat_runs AS run ON run.run_id = ${options.runId}
      WHERE space.space_id = ${options.spaceId} AND space.archived_at IS NULL
        AND ${runMayActSql(sql, "run")}
        AND json_extract(run.metadata_json, '$.run_policy.space.inference.enabled') = 1
        AND CASE json_extract(run.metadata_json, '$.run_context.origin.kind')
          WHEN 'space' THEN json_extract(run.metadata_json, '$.run_context.origin.space_id') = space.space_id
          WHEN 'task' THEN EXISTS (SELECT 1 FROM space_tasks AS origin_task
            WHERE origin_task.item_id = json_extract(run.metadata_json, '$.run_context.origin.item_id')
              AND origin_task.space_id = space.space_id)
          WHEN 'automation' THEN json_extract(run.metadata_json, '$.run_policy.space.space_id') = space.space_id
          ELSE 0 END`
    const policy = yield* decodeJson(TaskInferencePolicySchema, rows[0]?.inference_policy ?? "null")
    const captured = yield* decodeJson(
      TaskInferencePolicySchema,
      rows[0]?.captured_inference ?? "null"
    )
    if (!policy.enabled || !captured.enabled)
      return yield* workError("conflict", "Task inference is disabled for this Space")
    const review = yield* readInferenceReview({ sql, consistent: (read) => read }, options.spaceId)
    if (review.snapshot !== options.snapshot)
      return yield* workError(
        "conflict",
        "Space work changed since review; inspect the new Tasks and rejections before inferring again"
      )
    yield* assertSettledChatEvidence(sql, options.spaceId, options.sources)
    yield* assertInferenceNotRejected(sql, options.spaceId, options.sources)
    for (const source of options.sources) {
      if (source.revision === null)
        return yield* workError("invalid", "Inferred Tasks require exact evidence revisions")
      if (source.kind === "chat") {
        const evidence =
          yield* sql`SELECT 1 FROM chat_runs AS run JOIN sessions AS session ON session.session_id = run.session_id
          WHERE run.session_id = ${source.session_id} AND session.space_id = ${options.spaceId}
            AND json_extract(run.metadata_json, '$.turn_id') = ${source.turn_id}
            AND ${source.revision} = ${source.turn_id} LIMIT 1`
        if (evidence.length === 0)
          return yield* workError(
            "invalid",
            "Chat evidence must identify a recorded turn in this Space"
          )
      } else if (source.kind === "task") {
        yield* assertCurrentTaskRevision(sql, source.item_id, source.revision)
        if (source.item_id !== rows[0]?.origin_task)
          return yield* workError(
            "invalid",
            "A proposal cites only the Task whose worker is proposing it"
          )
      } else if (source.kind !== "memory" && source.kind !== "connection_item") {
        return yield* workError(
          "invalid",
          "A proposal needs Chat, Memory, routed item or its own Task evidence, not a bare Space reference"
        )
      }
    }
    yield* assertItemEvidence(sql, {
      spaceId: options.spaceId,
      proposalId: options.proposalId,
      sources: options.sources
    })
    yield* assertOpenProposalRoom(sql, { spaceId: options.spaceId, proposalId: options.proposalId })
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof WorkStoreError
        ? cause
        : workError(
            "invalid",
            "Inference requires an enabled Space worker and valid observed evidence",
            cause
          )
    )
  )
})

export const assertHomeProposalAdmission = Effect.fn("Work.admitHomeProposal")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly runId: string
    readonly sources: ReadonlyArray<SpaceTaskSource>
    readonly proposalId: string
  }
): Effect.fn.Return<void, WorkStoreError> {
  yield* Effect.gen(function* () {
    const rows = yield* sql<{
      readonly session_id: string
      readonly origin_task: string | null
    }>`SELECT run.session_id,
      CASE WHEN json_extract(run.metadata_json, '$.run_context.origin.kind') = 'task'
        THEN json_extract(run.metadata_json, '$.run_context.origin.item_id') END AS origin_task
      FROM chat_runs AS run
      WHERE run.run_id = ${options.runId} AND ${runMayActSql(sql, "run")}
        AND json_extract(run.metadata_json, '$.run_policy.space.space_id') IS NULL
        AND json_extract(run.metadata_json, '$.run_context.origin.kind') IN ('automation', 'task')`
    const run = rows[0]
    if (run === undefined)
      return yield* workError(
        "conflict",
        "Only an Automation or a Task worker with no Space proposes to Home"
      )
    for (const source of options.sources) {
      if (source.kind === "chat") {
        const own = yield* sql`SELECT 1 FROM chat_runs WHERE session_id = ${run.session_id}
          AND session_id = ${source.session_id}
          AND json_extract(metadata_json, '$.turn_id') = ${source.turn_id}
          AND ${source.revision} = ${source.turn_id} LIMIT 1`
        if (own.length === 0)
          return yield* workError(
            "invalid",
            "Chat evidence must be a recorded turn of this run's chat"
          )
      } else if (source.kind === "task") {
        yield* assertCurrentTaskRevision(sql, source.item_id, source.revision)
        if (source.item_id !== run.origin_task)
          return yield* workError(
            "invalid",
            "A proposal cites only the Task whose worker is proposing it"
          )
      } else if (source.kind !== "memory") {
        return yield* workError(
          "invalid",
          "With no Space, a proposal cites this run's chat, a Memory page it read, or its own Task"
        )
      }
    }
    yield* assertHomeProposalRoom(sql, options.proposalId)
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof WorkStoreError
        ? cause
        : workError("invalid", "Could not admit the proposal to Home", cause)
    )
  )
})

const assertSettledChatEvidence = Effect.fn("Work.settledChatEvidence")(function* (
  sql: SqlClient.SqlClient,
  spaceId: string,
  sources: ReadonlyArray<SpaceTaskSource>
) {
  return yield* requireSettledTurns(sources, yield* readChatSettled(sql, spaceId))
})

export const assertSettledCitedChats = Effect.fn("Work.settledCitedChats")(function* (
  sql: SqlClient.SqlClient,
  sources: ReadonlyArray<SpaceTaskSource>
) {
  const cited = sources.flatMap((source) => (source.kind === "chat" ? [source.session_id] : []))
  return yield* requireSettledTurns(sources, yield* readSessionSettled(sql, cited))
})

const requireSettledTurns = Effect.fn("Work.requireSettledTurns")(function* (
  sources: ReadonlyArray<SpaceTaskSource>,
  chats: ReadonlyArray<ChatSettledState>
) {
  for (const source of sources) {
    if (source.kind !== "chat") continue
    const chat = chats.find((row) => row.session_id === source.session_id)
    if (chat === undefined || !chat.settled || chat.turn_id !== source.turn_id)
      return yield* workError(
        "conflict",
        "Chat evidence is unfinished, queued, or unavailable; wait for its outcome and review again"
      )
  }
})
