import { Effect } from "effect"
import type { SqlClient, SqlError, Statement } from "effect/unstable/sql"
import type { ToolCallPlan } from "../work/task-direction.js"
import {
  descendantCalls,
  requireLiveWorkflowOwner,
  detachedOwnedCalls
} from "./detached-workflow-calls.js"
import type { PersistenceDeps } from "./deps.js"
import type { ToolExecutionStore, ToolExecutionStoreError } from "../tools/store.js"
import { preserveToolError, toolError, type ValidToolExecutionIdentity } from "./tool-rows.js"
import { NESTING, SCRIPT_NESTINGS, type CallParent, type NestingKind } from "../tools/tool-roles.js"

interface CallLineage {
  readonly parent: CallParent | undefined
  readonly script: string | undefined
}

const plannedParent = (plan: ToolCallPlan | undefined): CallParent | undefined =>
  plan === undefined || !("nesting" in plan) ? undefined : plan

const callLineage = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  parent: CallParent | undefined
) {
  if (parent === undefined) return { parent, script: undefined } satisfies CallLineage
  const rows = yield* sql<{ readonly script_tool_call_id: string | null }>`
    SELECT script_tool_call_id FROM tool_calls
    WHERE run_id = ${runId} AND tool_call_id = ${parent.toolCallId}`
  const inherited = rows[0]?.script_tool_call_id ?? undefined
  const script =
    inherited ?? (SCRIPT_NESTINGS.includes(parent.nesting.kind) ? parent.toolCallId : undefined)
  return { parent, script } satisfies CallLineage
})

export const beginLineage = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  identity: ValidToolExecutionIdentity,
  plan: ToolCallPlan | undefined
) {
  const lineage = yield* callLineage(sql, identity.runId, plannedParent(plan)).pipe(
    Effect.mapError(preserveToolError("begin", identity))
  )
  yield* requireLiveWorkflowOwner(sql, identity, "begin", lineage)
  return lineage
})

export const detachedLineage = (
  sql: SqlClient.SqlClient,
  identity: ValidToolExecutionIdentity,
  lineage: CallLineage
): Effect.Effect<ReadonlySet<string>, ToolExecutionStoreError> =>
  detachedOwnedCalls(
    sql,
    identity.runId,
    new Map(lineage.script === undefined ? [] : [[identity.toolCallId, lineage.script] as const])
  ).pipe(
    Effect.mapError((cause) =>
      toolError("begin", "storage", "Could not verify the detached workflow owner", identity, cause)
    )
  )

export const approvedFollowUpOf = (lineage: CallLineage): string | undefined =>
  lineage.parent?.nesting.kind === NESTING.approved ? lineage.parent.toolCallId : undefined

export const lineageColumns = (
  lineage: CallLineage
): readonly [string | null, NestingKind | null, string | null] => [
  lineage.parent?.toolCallId ?? null,
  lineage.parent?.nesting.kind ?? null,
  lineage.script ?? null
]

export const recordAgentCall = (
  sql: SqlClient.SqlClient,
  call: { readonly runId: string; readonly toolCallId: string },
  lineage: CallLineage
): Effect.Effect<unknown, SqlError.SqlError> => {
  const nesting = lineage.parent?.nesting
  return nesting?.kind === NESTING.workflow
    ? sql`INSERT OR IGNORE INTO script_agent_calls (run_id, tool_call_id, agent_key, launch)
        VALUES (${call.runId}, ${call.toolCallId}, ${nesting.agentKey}, ${nesting.launch})`
    : Effect.void
}

export const scriptAgentJoin = (sql: SqlClient.SqlClient, origin: string): Statement.Fragment =>
  sql`JOIN tool_calls AS spawn ON spawn.run_id = child.parent_run_id
      AND spawn.tool_call_id = child.parent_tool_call_id
      AND spawn.parent_tool_call_id = ${origin} AND spawn.nesting = ${NESTING.workflow}
    JOIN script_agent_calls AS agent ON agent.run_id = spawn.run_id
      AND agent.tool_call_id = spawn.tool_call_id`

export const makeToolDescends =
  ({ reader }: Pick<PersistenceDeps, "reader">): ToolExecutionStore["Service"]["descends"] =>
  (call, ancestor) =>
    call.toolCallId === ancestor
      ? Effect.succeed(true)
      : reader<{ readonly present: number }>`SELECT 1 AS present
          WHERE ${call.toolCallId} IN ${descendantCalls(reader, call.runId, ancestor)}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError((cause) =>
            toolError("history", "storage", "Could not read the call's parents", call, cause)
          )
        )
