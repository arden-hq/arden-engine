import { assertCurrentTaskRevision } from "./work-history.js"
import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { TaskProposalRetirementSourceSchema } from "@arden-hq/protocol/effect/proposals"
import { decodeChatToolEvidence, type ChatToolEvidenceRow } from "./chat-action-evidence.js"
import { TaskProposalStoreError, type RetireTaskProposalInput } from "../proposals/store.js"
import { isUserChatSession } from "./chat-ownership.js"
import { assertSettledCitedChats, readInferenceReview } from "./work-inference.js"
import { sourceIdentity, evidenceKey } from "./proposal-evidence.js"
import { runMayActSql } from "./run-liveness.js"

const conflict = (message: string) => new TaskProposalStoreError({ reason: "conflict", message })

export const retireProposal = Effect.fn("TaskProposal.retireInTransaction")(function* (
  sql: SqlClient.SqlClient,
  input: RetireTaskProposalInput
) {
  const sources = yield* Schema.decodeUnknownEffect(
    Schema.NonEmptyArray(TaskProposalRetirementSourceSchema)
  )(input.sources, { onExcessProperty: "error" })
  if (
    input.reason.trim().length === 0 ||
    sources.some((source) => source.revision === null) ||
    !sources.some(
      (source) =>
        source.kind === "chat" ||
        source.kind === "chat_action" ||
        source.kind === "memory" ||
        source.kind === "task" ||
        source.kind === "connection_item"
    )
  )
    return yield* conflict(
      "Retirement needs a reason and exact Chat, Memory, Task or connection item outcome evidence"
    )
  const authority = yield* sql`SELECT 1 FROM chat_runs AS run
    WHERE run.run_id = ${input.runId} AND ${runMayActSql(sql, "run")}
      AND json_extract(run.metadata_json, '$.run_context.origin.kind') = 'space'
      AND json_extract(run.metadata_json, '$.run_context.origin.space_id') = ${input.spaceId}`
  if (authority.length === 0)
    return yield* conflict(
      "Only this Space's review, or work it started that still runs, can retire its proposals"
    )
  const replay = yield* sql`SELECT 1 FROM task_proposals
    WHERE proposal_id = ${input.proposalId} AND space_id = ${input.spaceId}
      AND status = 'retired' AND json_extract(retirement_json, '$.run_id') = ${input.runId}
      AND json_extract(retirement_json, '$.tool_call_id') = ${input.toolCallId}
      AND json_extract(retirement_json, '$.reason') = ${input.reason}
      AND json_extract(retirement_json, '$.sources') = ${JSON.stringify(sources)}`
  if (replay.length > 0) return
  const review = yield* readInferenceReview({ sql, consistent: (read) => read }, input.spaceId)
  if (review.snapshot !== input.snapshot)
    return yield* conflict("Space evidence changed; review it again before retiring")
  const proposal = review.proposals.find((row) => row.proposal_id === input.proposalId)
  if (
    proposal === undefined ||
    proposal.status !== "offered" ||
    proposal.revision !== input.expectedRevision
  )
    return yield* conflict("The proposal changed or was already settled; review again")
  for (const source of sources) {
    switch (source.kind) {
      case "chat_action": {
        if (!(yield* isUserChatSession(sql, source.session_id)))
          return yield* conflict("Action evidence must come from one of your chats")
        const rows = yield* sql<ChatToolEvidenceRow>`SELECT call.rowid AS cursor, call.*,
          json_extract(run.metadata_json, '$.turn_id') AS turn_id
          FROM tool_calls AS call JOIN chat_runs AS run ON run.run_id = call.run_id AND run.session_id = call.session_id
          WHERE call.session_id = ${source.session_id} AND call.run_id = ${source.run_id}
            AND call.tool_call_id = ${source.tool_call_id}`
        const row = rows[0]
        const evidence = row === undefined ? undefined : (yield* decodeChatToolEvidence(row)).source
        if (
          evidence === undefined ||
          evidence.turn_id !== source.turn_id ||
          evidence.revision !== source.revision
        )
          return yield* conflict(
            "Action evidence must cite an exact completed applied mutation receipt"
          )
        break
      }
      case "task": {
        yield* assertCurrentTaskRevision(sql, source.item_id, source.revision).pipe(
          Effect.mapError((cause) => conflict(cause.message))
        )
        const tasks = yield* sql`SELECT 1 FROM space_tasks WHERE item_id = ${source.item_id}
          AND status != 'cancelled'`
        if (tasks.length === 0) return yield* conflict("Retirement must cite a live or done Task")
        break
      }
      case "connection_item": {
        const items = yield* sql`SELECT 1 FROM connection_items WHERE item_id = ${source.item_id}`
        if (items.length === 0 || source.revision !== source.item_id)
          return yield* conflict("Retirement must cite a stored connection item by its item_id")
        break
      }
      case "chat":
        if (source.revision !== source.turn_id)
          return yield* conflict("Cite a Chat turn with revision equal to its turn_id")
        break
      case "memory":
        break
      case "space":
        return yield* conflict("Retirement requires Chat, Memory, Task or item outcome evidence")
    }
  }
  const ordinarySources = sources.filter((source) => source.kind !== "chat_action")
  yield* assertSettledCitedChats(sql, ordinarySources)
  const observed = new Map(ordinarySources.map((source) => [sourceIdentity(source), source]))
  const receipt = JSON.stringify({
    run_id: input.runId,
    tool_call_id: input.toolCallId,
    reason: input.reason,
    sources,
    evidence_revision_key: evidenceKey(
      proposal.sources.map((source) => observed.get(sourceIdentity(source)) ?? source)
    )
  })
  const now = DateTime.formatIso(yield* DateTime.now)
  yield* sql`UPDATE task_proposals SET status = 'retired', retirement_json = ${receipt},
    revision = revision + 1, updated_at = ${now}, settled_at = ${now}
    WHERE proposal_id = ${input.proposalId}`
})
