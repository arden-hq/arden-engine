import type { RunContext } from "@arden-hq/protocol/runs"
import type { InteractionSchema } from "@arden-hq/protocol/effect/chat"
import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  RunAuthoritySchema,
  deriveAuthority,
  handedAuthority,
  narrow,
  orphanAgentAuthority,
  unrecordedAuthority,
  type AgentRequest,
  type AutomationFacts,
  type RunAuthority
} from "../../execution/authority.js"
import { RunPolicySchema, meetCapabilities, type RunPolicy } from "../../execution/policy.js"
import type { AgentSessionMetadata } from "../../sessions/agent-mode.js"
import { JobPurposeSchema } from "../job-classification.js"
import { runPolicyRevoked } from "./run-policy.js"
import { executionBudgetExpired } from "./execution-budgets.js"
import { RunContextSchema } from "@arden-hq/protocol/effect/runs"
import { decodeJson } from "./json.js"
import { writeError } from "./chat-write-errors.js"

const isJobPurpose = Schema.is(JobPurposeSchema)

export const readRunAuthority = Effect.fn("RunAuthority.read")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{ readonly authority_json: string | null }>`
    SELECT authority_json FROM chat_runs WHERE run_id = ${runId}`
  return storedAuthority(rows[0]?.authority_json ?? null)
})

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(RunAuthoritySchema))

export const storedAuthority = (json: string | null): RunAuthority | undefined =>
  json === null ? undefined : Option.getOrUndefined(decodeStored(json))

const automationFacts = Effect.fn("RunAuthority.automationFacts")(function* (
  sql: SqlClient.SqlClient,
  automationId: string | null
) {
  if (automationId === null) return null
  const rows = yield* sql<{
    readonly purpose: string
    readonly handler: string | null
    readonly owner_space_id: string | null
  }>`SELECT purpose, handler, owner_space_id FROM scheduled_tasks WHERE task_id = ${automationId}`
  const row = rows[0]
  if (row === undefined || !isJobPurpose(row.purpose)) return null
  return {
    automation_id: automationId,
    purpose: row.purpose,
    handler: row.handler,
    owner_space_id: row.owner_space_id
  } satisfies AutomationFacts
})

export const spawnerRun = (sql: SqlClient.SqlClient, sessionId: string) =>
  sql<{ readonly parent_run_id: string | null }>`
    SELECT parent_run_id FROM sessions WHERE session_id = ${sessionId}`.pipe(
    Effect.map((rows) => rows[0]?.parent_run_id ?? undefined)
  )

export const admissionAuthority = Effect.fn("RunAuthority.admission")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly sessionId: string
    readonly chatAutomationId: string | null
    readonly context: RunContext
    readonly policy: RunPolicy
    readonly agent: AgentSessionMetadata | null
    readonly source?: { readonly kind: "continuation" | "delegation"; readonly runId: string }
  }
) {
  if (input.source?.kind === "continuation") {
    const authority = yield* readRunAuthority(sql, input.source.runId)
    if (authority === undefined)
      return yield* writeError("start", "invalid", "The parent task's authority is unavailable")
    return authority
  }
  const own = yield* chatAuthority(sql, input)
  if (input.source === undefined) return own
  const sender = yield* readRunAuthority(sql, input.source.runId)
  const request = agentRequest(input, input.source.runId)
  return sender === undefined
    ? orphanAgentAuthority(request)
    : handedAuthority(sender, own, request)
})

const chatAuthority = Effect.fn("RunAuthority.chat")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly sessionId: string
    readonly chatAutomationId: string | null
    readonly context: RunContext
    readonly policy: RunPolicy
    readonly agent: AgentSessionMetadata | null
  }
) {
  if (input.agent !== null) {
    const parentRunId = yield* spawnerRun(sql, input.sessionId)
    if (parentRunId === undefined) return unrecordedAuthority(input.sessionId)
    return yield* delegateAuthority(sql, parentRunId, agentRequest(input, parentRunId))
  }
  const origin = input.context.origin
  return deriveAuthority({
    sessionId: input.sessionId,
    context: input.context,
    policy: input.policy,
    originAutomation: yield* automationFacts(
      sql,
      origin.kind === "automation" ? origin.automation_id : null
    ),
    chatAutomation: yield* automationFacts(sql, input.chatAutomationId)
  })
})

const agentRequest = (
  input: {
    readonly sessionId: string
    readonly context: RunContext
    readonly agent: AgentSessionMetadata | null
  },
  parentRunId: string
): AgentRequest => ({
  mode: input.agent?.mode ?? "work",
  sessionId: input.sessionId,
  parentRunId,
  workspaceRoot: input.agent?.mode === "code" ? (input.agent.workspace?.root ?? null) : null,
  taskItemId: input.context.task?.item_id ?? null
})

export const delegateAuthority = Effect.fn("RunAuthority.delegate")(function* (
  sql: SqlClient.SqlClient,
  parentRunId: string,
  request: AgentRequest
) {
  const parent = yield* readRunAuthority(sql, parentRunId)
  if (parent === undefined) return orphanAgentAuthority(request)
  const narrowed = narrow(parent, request)
  return narrowed.kind === "narrowed" ? narrowed.authority : orphanAgentAuthority(request)
})

export const handoffSender = Effect.fn("RunAuthority.handoffSender")(function* (
  sql: SqlClient.SqlClient,
  interaction: typeof InteractionSchema.Type | undefined,
  sessionId: string
) {
  if (
    interaction?.kind !== "message" ||
    interaction.from.type !== "agent" ||
    interaction.causedBy?.type !== "tool_call"
  )
    return undefined
  const rows = yield* sql<{
    readonly run_id: string
    readonly policy: string | null
    readonly parent_session_id: string | null
    readonly parent_run_id: string | null
    readonly tool_name: string
  }>`
    SELECT call.run_id, call.tool_name, json_extract(run.metadata_json, '$.run_policy') AS policy,
      source.parent_session_id, source.parent_run_id
    FROM tool_calls AS call
    JOIN sessions AS source ON source.session_id = call.session_id
    JOIN chat_runs AS run ON run.run_id = call.run_id
    WHERE source.public_ref = ${interaction.from.id} AND call.tool_call_id = ${interaction.causedBy.id}
    ORDER BY call.started_at DESC LIMIT 1`
  const row = rows[0]
  if (row?.policy == null)
    return yield* writeError(
      "start",
      "invalid",
      "An agent's message must come from a recorded tool call",
      {
        sessionId
      }
    )
  const parent =
    row.parent_session_id === sessionId && row.parent_run_id !== null
      ? (yield* sql<{ readonly policy: string; readonly context: string; readonly ended: number }>`
          SELECT json_extract(metadata_json, '$.run_policy') AS policy,
            json_extract(metadata_json, '$.run_context') AS context,
            (${runPolicyRevoked(sql, sql`metadata_json`, false)}
              OR ${executionBudgetExpired(sql, sql`metadata_json`)}) AS ended
          FROM chat_runs WHERE run_id = ${row.parent_run_id} AND session_id = ${sessionId}`)[0]
      : undefined
  if (row.parent_run_id !== null && parent !== undefined && !parent.ended) {
    return {
      kind: "continuation" as const,
      runId: row.parent_run_id,
      policy: yield* decodeJson(RunPolicySchema, parent.policy),
      context: yield* decodeJson(RunContextSchema, parent.context)
    }
  }
  return {
    kind: "delegation" as const,
    runId: row.run_id,
    tool: row.tool_name,
    policy: yield* decodeJson(RunPolicySchema, row.policy)
  }
})

export const handedPolicy = (
  own: RunPolicy,
  sender: { readonly policy: RunPolicy } | undefined
): RunPolicy =>
  sender === undefined
    ? own
    : { ...own, capabilities: meetCapabilities(own.capabilities, sender.policy.capabilities) }
