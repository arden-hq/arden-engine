import { quoted } from "@arden-hq/std/count"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { nextId } from "./deps.js"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { assertIndependentConversation } from "./space-conversation.js"
import { storeError } from "./session-rows.js"
import { activeRunStatusList } from "./status-sets.js"
import { sessionDescendants } from "./tree-walk.js"

type ConversationMove =
  | { readonly kind: "moved"; readonly spaceName: string | undefined }
  | { readonly kind: "on_run_end"; readonly spaceName: string | undefined }
  | { readonly kind: "missing" }

interface MoveRequest {
  readonly sql: SqlClient.SqlClient
  readonly sessionId: string
  readonly spaceId: string | undefined
  readonly askingRunId: string | undefined
  readonly mutation?: MutationOperationIdentity | undefined
}

export const moveConversationInTransaction = Effect.fn("SessionSpaceMove.move")(function* ({
  sql,
  sessionId,
  spaceId,
  askingRunId,
  mutation
}: MoveRequest) {
  yield* assertIndependentConversation({ sql, sessionId, operation: "move" })
  const sessions = yield* sql<{ readonly space_id: string | null; readonly automation: number }>`
    SELECT space_id, origin_automation_id IS NOT NULL AS automation
    FROM sessions
    WHERE session_id = ${sessionId} AND archived_at IS NULL
    LIMIT 1
  `
  const session = sessions[0]
  if (session === undefined) return { kind: "missing" } satisfies ConversationMove
  if (session.automation === 1) {
    return yield* storeError(
      "move",
      "conflict",
      "A chat an Automation owns cannot move to another Space.",
      sessionId
    )
  }

  const spaceName =
    spaceId === undefined ? undefined : yield* liveSpaceName(sql, sessionId, spaceId)
  const active = yield* activeWork(sql, sessionId)
  if (active.length > 0) {
    if (askingRunId !== undefined && active.every((run) => run.run_id === askingRunId)) {
      yield* holdMove(sql, askingRunId, sessionId, spaceId, mutation)
      return { kind: "on_run_end", spaceName } satisfies ConversationMove
    }
    return yield* storeError(
      "move",
      "conflict",
      busyMessage(active, sessionId, askingRunId),
      sessionId
    )
  }

  const moved = yield* sql<{ readonly session_id: string }>`
    WITH RECURSIVE ${conversationSubtree(sql, sessionId)}
    UPDATE sessions
    SET space_id = ${spaceId ?? null}
    WHERE session_id IN (SELECT session_id FROM subtree) AND space_id IS NOT ${spaceId ?? null}
    RETURNING session_id
  `
  if (moved.length === 0) return { kind: "moved", spaceName } satisfies ConversationMove
  const operationId = yield* nextId
  const memberIds = moved.map((row) => row.session_id)
  yield* sql`INSERT INTO session_membership_changes (session_id, version, operation_id)
    SELECT session_id, MAX(version), ${operationId} FROM session_revisions
    WHERE session_id IN ${sql.in(memberIds)} GROUP BY session_id`
  if (mutation !== undefined) {
    yield* sql`INSERT INTO session_mutation_links (session_id, version, run_id, tool_call_id)
      SELECT member.session_id, member.version, ${mutation.runId}, ${mutation.toolCallId}
      FROM session_membership_changes AS member
      WHERE member.operation_id = ${operationId}
        AND EXISTS (SELECT 1 FROM tool_calls WHERE run_id = ${mutation.runId}
          AND tool_call_id = ${mutation.toolCallId} AND changes_state = 1)`
  }
  return { kind: "moved", spaceName } satisfies ConversationMove
})

export const applySpaceMoveAtRunEnd = Effect.fn("SessionSpaceMove.applyAtRunEnd")(
  function* ({ sql, runId }: { readonly sql: SqlClient.SqlClient; readonly runId: string }) {
    const held = yield* sql<{
      readonly session_id: string
      readonly space_id: string | null
      readonly origin_run_id: string | null
      readonly origin_tool_call_id: string | null
    }>`
      SELECT json_extract(metadata_json, '$.space_move.session_id') AS session_id,
             json_extract(metadata_json, '$.space_move.space_id') AS space_id,
             json_extract(metadata_json, '$.space_move.origin_run_id') AS origin_run_id,
             json_extract(metadata_json, '$.space_move.origin_tool_call_id') AS origin_tool_call_id
      FROM chat_runs
      WHERE run_id = ${runId} AND json_type(metadata_json, '$.space_move') = 'object'
    `
    const move = held[0]
    if (move === undefined) return
    yield* sql`UPDATE chat_runs SET metadata_json = json_remove(metadata_json, '$.space_move')
      WHERE run_id = ${runId}`
    const mutation =
      move.origin_run_id !== null && move.origin_tool_call_id !== null
        ? { runId: move.origin_run_id, toolCallId: move.origin_tool_call_id }
        : undefined
    const spaceId = move.space_id ?? undefined
    const remaining = yield* activeWork(sql, move.session_id)
    const next = remaining[0]
    if (next !== undefined) {
      yield* holdMove(sql, next.run_id, move.session_id, spaceId, mutation)
      return
    }
    const moved = yield* moveConversationInTransaction({
      sql,
      sessionId: move.session_id,
      spaceId,
      askingRunId: undefined,
      mutation
    })
    return moved.kind === "moved" ? mutation : undefined
  },
  (effect, { runId }) =>
    Effect.catchCause(effect, (cause) =>
      Effect.logWarning("Could not move a Chat when the run that asked ended", { runId, cause })
    )
)

interface ActiveRun {
  readonly run_id: string
  readonly session_id: string
  readonly name: string | null
}

const conversationSubtree = (sql: SqlClient.SqlClient, sessionId: string) =>
  sessionDescendants(sql, {
    name: "subtree",
    from: sql`SELECT session_id FROM sessions WHERE session_id = ${sessionId}`,
    where: sql`child.origin_automation_id IS NULL`
  })

const activeWork = (sql: SqlClient.SqlClient, sessionId: string) =>
  sql<ActiveRun>`
    WITH RECURSIVE ${conversationSubtree(sql, sessionId)}
    SELECT run.run_id, run.session_id, session.name
    FROM chat_runs AS run
    JOIN sessions AS session ON session.session_id = run.session_id
    WHERE run.session_id IN (SELECT session_id FROM subtree)
      AND run.status IN ${activeRunStatusList}
    ORDER BY run.started_at, run.run_id
  `

const holdMove = (
  sql: SqlClient.SqlClient,
  runId: string,
  sessionId: string,
  spaceId: string | undefined,
  mutation: MutationOperationIdentity | undefined
) =>
  sql`UPDATE chat_runs
    SET metadata_json = json_set(metadata_json, '$.space_move',
      json_object('session_id', ${sessionId}, 'space_id', ${spaceId ?? null},
        'origin_run_id', ${mutation?.runId ?? null}, 'origin_tool_call_id', ${mutation?.toolCallId ?? null}))
    WHERE run_id = ${runId}`

const liveSpaceName = Effect.fn("SessionSpaceMove.liveSpaceName")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  spaceId: string
) {
  const spaces = yield* sql<{ readonly name: string }>`
    SELECT name FROM spaces WHERE space_id = ${spaceId} AND archived_at IS NULL LIMIT 1
  `
  const space = spaces[0]
  if (space === undefined) {
    return yield* storeError("move", "not_found", "Target Space not found", sessionId)
  }
  return space.name
})

const MAX_NAMED_AGENTS = 3

const busyMessage = (
  active: ReadonlyArray<ActiveRun>,
  sessionId: string,
  askingRunId: string | undefined
): string => {
  const others = active.filter((run) => run.run_id !== askingRunId)
  const inChat = others.filter((run) => run.session_id === sessionId).length
  const agents = [
    ...new Set(
      others.filter((run) => run.session_id !== sessionId).map((run) => run.name ?? "untitled")
    )
  ]
  const named = agents.slice(0, MAX_NAMED_AGENTS).map((name) => quoted(name))
  const more = agents.length - named.length
  const parts = [
    ...(inChat === 0
      ? []
      : [askingRunId === undefined ? "a reply in this Chat" : "another reply in this Chat"]),
    ...(agents.length === 0
      ? []
      : [
          `${agents.length === 1 ? "agent" : "agents"} ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
        ])
  ]
  const running = parts.join(" and ")
  return `This Chat can't move while ${running} ${inChat + agents.length === 1 ? "is" : "are"} still running. Move it once that work is done.`
}
