import { captureMutationVersions } from "./mutation-links.js"
import type { TaskProposal, TaskProposalCapturePolicy } from "@arden-hq/protocol/proposals"
import {
  SpaceTaskCaptureInputSchema,
  SpaceTaskSourceSchema,
  decodeCreateSpaceTaskInputEffect
} from "@arden-hq/protocol/effect/spaces/work"
import { RunContextSchema } from "@arden-hq/protocol/effect/runs"
import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { TaskProposalConflictError } from "../proposals/conflict.js"
import { TaskProposalStoreError, type ReviseTaskProposalInput } from "../proposals/store.js"
import { runMayActSql } from "./run-liveness.js"
import { decodeJson } from "./json.js"
import { evidenceKey } from "./proposal-evidence.js"
import { assertInferenceAdmission } from "./work-inference.js"
import type { ProposalRow } from "./task-proposals.js"
import type { Writer } from "./deps.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { sha256Hex } from "@arden-hq/std/hash"

const failure = (
  reason: TaskProposalStoreError["reason"],
  message: string,
  cause?: unknown
): TaskProposalStoreError =>
  new TaskProposalStoreError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const proposalHash = (value: unknown): string => sha256Hex(JSON.stringify(value))

export const makeProposalRevision = (options: {
  readonly writer: Writer
  readonly sql: SqlClient.SqlClient
  readonly canonicalizeSources: (
    sources: ReadonlyArray<typeof SpaceTaskSourceSchema.Type>
  ) => Effect.Effect<ReadonlyArray<typeof SpaceTaskSourceSchema.Type>, TaskProposalStoreError>
  readonly read: (proposalId: string) => Effect.Effect<ProposalRow, TaskProposalStoreError>
  readonly project: (row: ProposalRow) => Effect.Effect<TaskProposal, TaskProposalStoreError>
  readonly changed: (row: ProposalRow) => Effect.Effect<void, TaskProposalStoreError, UnitOfWork>
}): ((
  input: ReviseTaskProposalInput
) => Effect.Effect<TaskProposal, TaskProposalStoreError | TaskProposalConflictError>) => {
  const { writer, sql, canonicalizeSources, read, project, changed } = options
  return Effect.fn("TaskProposal.revise")(function* (request: ReviseTaskProposalInput) {
    const taskCapture = yield* Schema.decodeUnknownEffect(SpaceTaskCaptureInputSchema)(
      request.capture,
      { onExcessProperty: "error" }
    ).pipe(Effect.mapError((cause) => failure("invalid", "Invalid revised Task capture", cause)))
    if (taskCapture.basis !== "inferred") {
      return yield* failure("invalid", "Revised Task proposals require inferred capture")
    }
    const decodedSources = yield* Schema.decodeUnknownEffect(Schema.Array(SpaceTaskSourceSchema))(
      request.sources,
      { onExcessProperty: "error" }
    ).pipe(Effect.mapError((cause) => failure("invalid", "Invalid revised Task evidence", cause)))
    if (decodedSources.length === 0) {
      return yield* failure("invalid", "Revised Task proposals require source evidence")
    }
    const sources = yield* canonicalizeSources(decodedSources)
    const now = DateTime.formatIso(yield* DateTime.now)

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "proposal",
            id: request.proposalId,
            identity: { runId: request.runId, toolCallId: request.toolCallId }
          })
          const row = yield* read(request.proposalId)
          if (row.place !== "space" || row.space_id !== request.spaceId) {
            return yield* new TaskProposalConflictError({
              kind: "not_offered",
              message: "Only this Space's open proposal can be revised"
            })
          }
          if (row.status !== "offered") {
            return yield* new TaskProposalConflictError({
              kind:
                row.status === "accepted" || row.status === "rejected" || row.status === "retired"
                  ? "settled"
                  : "not_offered",
              message: "This proposal is no longer open"
            })
          }
          if (row.revision !== request.expectedRevision) {
            return yield* new TaskProposalConflictError({
              kind: "proposal_changed",
              message: "This proposal changed; review it again"
            })
          }
          const space = yield* sql`SELECT 1 FROM spaces
          WHERE space_id = ${request.spaceId} AND archived_at IS NULL`
          if (space.length === 0) {
            return yield* new TaskProposalConflictError({
              kind: "space_unavailable",
              message: "This Space is archived"
            })
          }
          const authority = yield* sql`SELECT 1 FROM chat_runs AS run
          JOIN scheduled_tasks AS job
            ON job.task_id = json_extract(run.metadata_json, '$.automation.task_id')
          WHERE run.run_id = ${request.runId} AND run.session_id = ${request.sessionId}
            AND ${runMayActSql(sql, "run")} AND job.purpose = 'space_review'
            AND job.owner_space_id = ${request.spaceId}
            AND json_extract(run.metadata_json, '$.run_context.origin.kind') = 'space'
            AND json_extract(run.metadata_json, '$.run_context.origin.space_id') = ${request.spaceId}`
          if (authority.length === 0) {
            return yield* failure(
              "conflict",
              "Only this Space's review, or work it started that still runs, can revise its proposals"
            )
          }
          yield* assertInferenceAdmission(sql, {
            spaceId: request.spaceId,
            runId: request.runId,
            snapshot: request.inferenceSnapshot,
            sources,
            proposalId: request.proposalId
          }).pipe(Effect.mapError((error) => failure(error.reason, error.message, error)))

          const runRows = yield* sql<{
            readonly turn_id: string | null
            readonly context_json: string
          }>`SELECT json_extract(metadata_json, '$.turn_id') AS turn_id,
          json_extract(metadata_json, '$.run_context') AS context_json
          FROM chat_runs WHERE run_id = ${request.runId} AND session_id = ${request.sessionId}`
          const run = runRows[0]
          if (run === undefined || run.turn_id === null) {
            return yield* failure("invalid", "Task proposal source identity is not the active Run")
          }
          const context = yield* decodeJson(RunContextSchema, run.context_json).pipe(
            Effect.mapError((cause) =>
              failure("storage", "Task proposal Run context is corrupt", cause)
            )
          )
          const capturePolicy: TaskProposalCapturePolicy = {
            origin: context.origin.kind,
            task_item_id: context.task?.item_id ?? null,
            task_generation: context.task?.generation ?? null
          }
          const input = yield* decodeCreateSpaceTaskInputEffect({
            ...request.input,
            key: row.stable_key
          }).pipe(Effect.mapError((cause) => failure("invalid", "Invalid revised Task", cause)))
          const evidenceRevisionKey = evidenceKey(sources)
          const owner = input.owner ?? row.owner
          const candidateHash = proposalHash({
            stable_key: row.stable_key,
            text: input.text,
            body: input.body ?? null,
            owner,
            capture: taskCapture,
            sources
          })
          const signals = yield* sql<{ readonly signal: string }>`SELECT json_object(
            'source', item.source, 'account', item.account, 'thread_key', item.thread_key,
            'title', item.title, 'from', item.sender) AS signal
          FROM json_each(${JSON.stringify(sources)}) AS cited
          JOIN connection_items AS item ON item.item_id = json_extract(cited.value, '$.item_id')
          WHERE json_extract(cited.value, '$.kind') = 'connection_item'
          ORDER BY cited.key LIMIT 1`
          yield* sql`UPDATE task_proposals SET
          text = ${input.text}, body = ${input.body ?? null}, owner = ${owner},
          capture_json = ${JSON.stringify(taskCapture)}, sources_json = ${JSON.stringify(sources)},
          signal_json = ${signals[0]?.signal ?? null}, evidence_revision_key = ${evidenceRevisionKey},
          candidate_hash = ${candidateHash}, source_run_id = ${request.runId},
          source_session_id = ${request.sessionId}, source_turn_id = ${run.turn_id},
          source_tool_call_id = ${request.toolCallId}, capture_policy_json = ${JSON.stringify(capturePolicy)},
          revision = revision + 1, updated_at = ${now}
          WHERE proposal_id = ${request.proposalId} AND status = 'offered'
            AND revision = ${request.expectedRevision}`
          const updated = yield* read(request.proposalId)
          if (updated.revision !== request.expectedRevision + 1) {
            return yield* new TaskProposalConflictError({
              kind: "proposal_changed",
              message: "This proposal changed; review it again"
            })
          }
          const proposal = yield* project(updated)
          yield* changed(row)
          yield* recordVersions
          return proposal
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof TaskProposalStoreError || cause instanceof TaskProposalConflictError
            ? cause
            : failure("storage", "Could not revise Task proposal", cause)
        )
      )
  })
}
