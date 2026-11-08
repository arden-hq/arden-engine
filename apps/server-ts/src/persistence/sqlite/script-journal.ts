import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"

import {
  ScriptJournal,
  ScriptJournalError,
  type AgentDecision,
  type NestedResolution,
  type RetryVerdict,
  type ScriptAgentView,
  type ScriptDefinition,
  type ScriptOrigin
} from "../scripts/journal.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"
import { callChange } from "./run-effects.js"
import {
  agentReuseDecision,
  latestNestedRuns,
  nestedRerunId,
  nestedRetryDecision,
  nestedRun,
  nextLaunch,
  parseScriptChildId,
  retryVerdict,
  scriptChildPrefix,
  scriptChildRun,
  type CallChange,
  type NestedCall,
  type OutputVerdict,
  type ScriptChild,
  type ScriptChildId
} from "./script-derive.js"
import { readScriptExecutions } from "./script-executions.js"
import { readNestedCallFacts, withCallFacts } from "./change-evidence.js"
import { activeScriptChildRuns, observeChildRunEffects } from "./script-child-effects.js"

interface ChildRow {
  readonly parent_tool_call_id: string
  readonly run_id: string | null
  readonly run_status: string | null
  readonly content: string | null
}

interface NestedRow {
  readonly tool_call_id: string
  readonly status: string
  readonly is_error: number | null
  readonly rejected: number
  readonly change: CallChange
}

type JournalCall = NestedCall & { readonly toolCallId: string; readonly rejected: boolean }

const journalError = (message: string) => (cause: unknown) =>
  new ScriptJournalError({ message, cause })

const isNestedStatus = Schema.is(
  Schema.Literals(["running", "ready", "completed", "paused", "uncertain"] as const)
)

const outputCheck = (
  schema: Readonly<Record<string, Schema.Json>> | undefined
): ((text: string) => OutputVerdict) => {
  if (schema === undefined) return (text) => ({ valid: true, value: text })
  const validate = new AjvJsonSchemaValidator().getValidator<Schema.Json>(schema)
  return (text) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { valid: false }
    }
    const checked = validate(parsed)
    return checked.valid ? { valid: true, value: checked.data } : { valid: false }
  }
}

const readScriptChildren = Effect.fn("ScriptJournal.children")(function* (
  sql: SqlClient.SqlClient,
  origin: ScriptOrigin,
  include: (id: ScriptChildId) => boolean = () => true
) {
  const prefix = scriptChildPrefix(origin.originToolCallId)
  const rows = yield* sql<ChildRow>`
    SELECT child.parent_tool_call_id, run.run_id, run.status AS run_status,
      (SELECT CASE WHEN json_type(message.message_json, '$.content') = 'text'
                   THEN json_extract(message.message_json, '$.content') END
       FROM session_messages AS message
       WHERE message.session_id = child.session_id AND message.role = 'assistant'
       ORDER BY message.seq DESC
       LIMIT 1) AS content
    FROM sessions AS child
    LEFT JOIN chat_runs AS run ON run.run_id = (
      SELECT first.run_id FROM chat_runs AS first
      WHERE first.session_id = child.session_id
      ORDER BY first.started_at, first.run_id
      LIMIT 1
    )
    WHERE child.parent_run_id = ${origin.originRunId}
      AND child.session_type = 'agent'
      AND substr(child.parent_tool_call_id, 1, ${prefix.length}) = ${prefix}
    ORDER BY child.started_at, child.session_id
  `.pipe(Effect.mapError(journalError("Could not read the script's agents")))
  const matched = rows.flatMap((row) => {
    const id = parseScriptChildId(origin.originToolCallId, row.parent_tool_call_id)
    return id !== undefined && include(id) ? [{ row, id }] : []
  })
  return yield* Effect.forEach(
    matched,
    Effect.fn("ScriptJournal.child")(function* ({ row, id }) {
      const observed =
        row.run_id === null
          ? { effectDisposition: "unknown" as const, sourceRefs: [] }
          : yield* observeChildRunEffects(sql, row.run_id).pipe(
              Effect.mapError(journalError("Could not read what a script agent changed"))
            )
      return {
        toolCallId: row.parent_tool_call_id,
        id,
        run: scriptChildRun(row.run_status ?? undefined, row.content ?? undefined),
        effect: observed.effectDisposition,
        sourceRefs: observed.sourceRefs
      } satisfies ScriptChild
    })
  )
})

const readNestedCalls = Effect.fn("ScriptJournal.nested")(function* (
  sql: SqlClient.SqlClient,
  origin: ScriptOrigin,
  base?: string
) {
  const prefix = base ?? `${origin.originToolCallId}:code:`
  const rows = yield* sql<NestedRow>`
    SELECT call.tool_call_id, call.status,
           json_extract(call.result_json, '$.is_error') AS is_error,
           EXISTS (SELECT 1 FROM tool_approvals AS decision
             WHERE decision.run_id = call.run_id AND decision.tool_call_id = call.tool_call_id
               AND decision.status = 'rejected') AS rejected,
           ${callChange(sql)} AS change
    FROM tool_calls AS call
    WHERE call.run_id = ${origin.originRunId}
      AND substr(call.tool_call_id, 1, ${prefix.length}) = ${prefix}
  `.pipe(Effect.mapError(journalError("Could not read the script's nested calls")))
  return rows.flatMap((row): ReadonlyArray<JournalCall> => {
    if (!isNestedStatus(row.status)) return []
    if (base !== undefined && nestedRun(row.tool_call_id).base !== base) return []
    return [
      {
        toolCallId: row.tool_call_id,
        status: row.status,
        isError: row.is_error === 1,
        rejected: row.rejected === 1,
        change: row.change
      }
    ]
  })
})

const scriptAgentDecision = Effect.fn("ScriptJournal.agentDecision")(function* (
  sql: SqlClient.SqlClient,
  input: Parameters<ScriptJournal["Service"]["agentDecision"]>[0]
): Effect.fn.Return<AgentDecision, ScriptJournalError> {
  const children = yield* readScriptChildren(sql, input, (id) => id.key === input.key)
  const decided = agentReuseDecision(children, outputCheck(input.schema))
  switch (decided.kind) {
    case "launch":
      return { kind: "launch", launch: nextLaunch(children) }
    case "refuse":
      return decided
    case "reuse":
      return {
        ...decided,
        sourceRefs:
          children.find((child) => child.toolCallId === decided.toolCallId)?.sourceRefs ?? []
      }
  }
})

const scriptNestedCall = Effect.fn("ScriptJournal.nestedCall")(function* (
  sql: SqlClient.SqlClient,
  input: Parameters<ScriptJournal["Service"]["nestedCall"]>[0]
): Effect.fn.Return<NestedResolution, ScriptJournalError> {
  const latest = latestNestedRuns(yield* readNestedCalls(sql, input, input.toolCallId))[0]
  if (latest === undefined) return { kind: "run", toolCallId: input.toolCallId }
  if (latest.rejected) return { kind: "run", toolCallId: latest.toolCallId }
  switch (nestedRetryDecision(latest)) {
    case "reuse":
      return { kind: "run", toolCallId: latest.toolCallId }
    case "rerun":
      return latest.status === "ready"
        ? { kind: "run", toolCallId: latest.toolCallId }
        : { kind: "run", toolCallId: nestedRerunId(input.toolCallId, input.attempt) }
    case "refuse":
      return {
        kind: "refuse",
        toolCallId: latest.toolCallId,
        effect: latest.change === "applied" ? "applied" : "unknown"
      }
  }
})

const scriptRetryVerdict = Effect.fn("ScriptJournal.retryVerdict")(function* (
  sql: SqlClient.SqlClient,
  origin: ScriptOrigin
): Effect.fn.Return<RetryVerdict, ScriptJournalError> {
  return retryVerdict({
    children: yield* readScriptChildren(sql, origin),
    nested: yield* readNestedCalls(sql, origin)
  })
})

interface AgentRow {
  readonly run_id: string | null
  readonly parent_tool_call_id: string
  readonly public_ref: string
  readonly name: string | null
  readonly mode: string | null
  readonly run_status: string | null
}

const agentMode = (mode: string | null): ScriptAgentView["mode"] =>
  mode === "research" || mode === "code" ? mode : null

const agentStatus = (runStatus: string | null): ScriptAgentView["status"] => {
  const run = scriptChildRun(runStatus ?? undefined, undefined)
  switch (run.status) {
    case "active":
      return "running"
    case "missing":
      return "failed"
    case "completed":
      return "completed"
    case "failed":
    case "interrupted":
    case "cancelled":
      return "failed"
  }
}

const readAgents = Effect.fn("ScriptJournal.agents")(function* (
  sql: SqlClient.SqlClient,
  origin: ScriptOrigin
) {
  const prefix = scriptChildPrefix(origin.originToolCallId)
  const rows = yield* sql<AgentRow>`
    SELECT child.parent_tool_call_id, child.public_ref, child.name,
           json_extract(child.metadata, '$.agent.mode') AS mode, run.status AS run_status, run.run_id
    FROM sessions AS child
    LEFT JOIN chat_runs AS run ON run.run_id = (
      SELECT first.run_id FROM chat_runs AS first
      WHERE first.session_id = child.session_id
      ORDER BY first.started_at, first.run_id
      LIMIT 1
    )
    WHERE child.parent_run_id = ${origin.originRunId}
      AND child.session_type = 'agent'
      AND substr(child.parent_tool_call_id, 1, ${prefix.length}) = ${prefix}
    ORDER BY child.started_at, child.session_id
  `.pipe(Effect.mapError(journalError("Could not read the script's agents")))
  const byKey = new Map<string, ScriptAgentView>()
  for (const row of rows) {
    const id = parseScriptChildId(origin.originToolCallId, row.parent_tool_call_id)
    if (id === undefined) continue
    byKey.set(id.key, {
      key: id.key,
      attempts: [
        ...(byKey.get(id.key)?.attempts ?? []),
        {
          session_ref: row.public_ref,
          run_id: row.run_id,
          tool_call_id: row.parent_tool_call_id,
          status: row.run_status ?? "unavailable"
        }
      ],
      label: row.name ?? "Agent",
      mode: agentMode(row.mode),
      status: agentStatus(row.run_status),
      sessionRef: row.public_ref
    })
  }
  return [...byKey.values()]
})

const DefinitionSchema = Schema.Struct({
  code: Schema.String,
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  max_agents: Schema.optionalKey(Schema.Int)
})

const DEFAULT_MAX_AGENTS = 100

const readDefinition = Effect.fn("ScriptJournal.definition")(function* (
  sql: SqlClient.SqlClient,
  origin: ScriptOrigin
): Effect.fn.Return<ScriptDefinition | undefined, ScriptJournalError> {
  const rows = yield* sql<{ readonly arguments_json: string }>`
    SELECT arguments_json FROM tool_calls
    WHERE run_id = ${origin.originRunId} AND tool_call_id = ${origin.originToolCallId}
  `.pipe(Effect.mapError(journalError("Could not read the script's code")))
  const row = rows[0]
  if (row === undefined) return undefined
  const decoded = yield* decodeJson(DefinitionSchema, row.arguments_json).pipe(Effect.option)
  if (Option.isNone(decoded)) return undefined
  return {
    code: decoded.value.code,
    args: decoded.value.args ?? {},
    maxAgents: decoded.value.max_agents ?? DEFAULT_MAX_AGENTS
  }
})

export const makeScriptJournal = ({
  reader
}: Pick<PersistenceDeps, "reader">): ScriptJournal["Service"] =>
  ScriptJournal.of({
    agentDecision: (input) => scriptAgentDecision(reader, input),
    nestedCall: (input) => scriptNestedCall(reader, input),
    retryVerdict: (origin) => scriptRetryVerdict(reader, origin),
    awaitingDecision: (origin) => {
      const prefix = `${origin.originToolCallId}:`
      return reader<{ readonly present: number }>`SELECT 1 AS present FROM tool_approvals
        WHERE run_id = ${origin.originRunId} AND status = 'pending'
          AND substr(tool_call_id, 1, ${prefix.length}) = ${prefix}
        LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(journalError("Could not read the script's pending decisions"))
      )
    },
    observeChild: (runId) =>
      observeChildRunEffects(reader, runId).pipe(
        Effect.mapError(journalError("Could not read what a script agent changed"))
      ),
    activeChildRuns: (origin) =>
      activeScriptChildRuns(reader, origin).pipe(
        Effect.mapError(journalError("Could not read the script's running agents"))
      ),
    agents: (origin) => readAgents(reader, origin),
    definition: (origin) => readDefinition(reader, origin),
    executions: (origin) =>
      readScriptExecutions(reader, origin).pipe(
        Effect.flatMap((saved) =>
          readNestedCallFacts(reader, {
            runId: origin.originRunId,
            toolCallId: origin.originToolCallId
          }).pipe(
            Effect.map((calls) =>
              saved.map((execution) => ({
                ...execution,
                data: withCallFacts(calls, execution.data)
              }))
            ),
            Effect.mapError(journalError("Could not read what a script's calls did"))
          )
        )
      )
  })
