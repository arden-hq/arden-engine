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
import { runMayActSql } from "./run-liveness.js"
import { openProposalStatusList, refusedProposalStatusList } from "./status-sets.js"
import { ownerTurnFingerprint, readChatSettled, userChatSql } from "./chat-ownership.js"
import {
  citedTurnFinished,
  HOME_OFFER_SOURCES,
  offerAnchorRefusal,
  UNFINISHED_TURN
} from "./offer-rules.js"
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
        // The owner's No: an offer rejected, or left to expire, keeps its own status.
        const refusedProposals = yield* sql<{
          readonly proposal_id: string
          readonly status: "rejected" | "expired"
          readonly sources: string
          readonly reason: string
        }>`SELECT proposal_id, status, sources_json AS sources,
      json_extract(capture_json, '$.reason') AS reason
      FROM task_proposals
      WHERE space_id = ${spaceId} AND status IN ${refusedProposalStatusList}
      ORDER BY proposal_id LIMIT 1001`
        // An inferred Task the owner stopped, whether it came from an offer or not.
        const stoppedTasks = yield* sql<{
          readonly proposal_id: string | null
          readonly item_id: string
          readonly sources: string
          readonly reason: string
        }>`SELECT task.item_id,
      (SELECT proposal.proposal_id FROM task_proposals AS proposal
        WHERE proposal.item_id = task.item_id AND proposal.status = 'accepted'
        ORDER BY proposal.proposal_id LIMIT 1) AS proposal_id,
      COALESCE((SELECT json_group_array(json(cited.source)) FROM (SELECT source.source
        FROM space_task_sources AS source WHERE source.item_id = task.item_id
        ORDER BY source.source_key) AS cited), '[]') AS sources,
      COALESCE(json_extract(task.capture, '$.reason'), '') AS reason
      FROM space_tasks AS task
      WHERE task.space_id = ${spaceId} AND task.status = 'cancelled'
        AND json_extract(task.capture, '$.basis') = 'inferred'
      ORDER BY task.item_id LIMIT 1001`
        if (
          tasks.length > 1000 ||
          proposals.length > 1000 ||
          refusedProposals.length + stoppedTasks.length > 1000
        ) {
          return yield* workError(
            "conflict",
            "This Space exceeds the inference review window; automatic capture is paused until its complete history can be reviewed"
          )
        }
        const rejections = yield* Effect.forEach(
          [
            ...refusedProposals.map((row) => ({
              kind: row.status === "rejected" ? ("proposal" as const) : ("expired" as const),
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
            chats: ownerTurnFingerprint(chats),
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
    const unanchored = offerAnchorRefusal("space", options.sources)
    if (unanchored !== undefined) return yield* workError("invalid", unanchored)
    const review = yield* readInferenceReview({ sql, consistent: (read) => read }, options.spaceId)
    if (review.snapshot !== options.snapshot)
      return yield* workError(
        "conflict",
        "Space work changed since review; inspect the new Tasks and rejections before inferring again"
      )
    yield* assertCitedTurnsFinished(sql, options.sources)
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
          "A proposal needs Chat, Memory, stored item or its own Task evidence, not a bare Space reference"
        )
      }
    }
    yield* assertItemEvidence(sql, {
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
    const unanchored = offerAnchorRefusal("home", options.sources)
    if (unanchored !== undefined) return yield* workError("invalid", unanchored)
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
        return yield* workError("invalid", HOME_OFFER_SOURCES)
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

/** Every cited chat turn has finished, in one of the owner's chats (see `citedTurnFinished`).
 * Propose, revise and retire all check chat evidence here. */
export const assertCitedTurnsFinished = Effect.fn("Work.citedTurnsFinished")(function* (
  sql: SqlClient.SqlClient,
  sources: ReadonlyArray<SpaceTaskSource>
) {
  for (const source of sources) {
    if (source.kind !== "chat") continue
    const runs = yield* sql<{ readonly status: string }>`SELECT run.status
      FROM chat_runs AS run JOIN sessions AS session ON session.session_id = run.session_id
      WHERE run.session_id = ${source.session_id}
        AND json_extract(run.metadata_json, '$.turn_id') = ${source.turn_id}
        AND ${userChatSql("session")} AND session.archived_at IS NULL`
    if (!citedTurnFinished(runs.map((run) => run.status)))
      return yield* workError("conflict", UNFINISHED_TURN)
  }
})
