import type { WorkflowEffectDisposition, WorkflowSourceRef } from "@arden-hq/protocol/workflows"
import { WorkflowSourceRefSchema } from "@arden-hq/protocol/effect/workflows"
import { Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"

import { readManagedObjectDescriptor } from "../managed-output/descriptor.js"
import { addSourceRefs, boundedSourceRefs } from "../workflows/source-refs.js"
import { decodeJson } from "./json.js"
import { callChange } from "./run-effects.js"
import { callEffect, mergeEffectDisposition, type CallChange } from "./script-derive.js"
import { activeRunStatusList } from "./status-sets.js"
import { sessionDescendants } from "./tree-walk.js"

export interface ChildObservation {
  readonly effectDisposition: WorkflowEffectDisposition
  readonly sourceRefs: ReadonlyArray<WorkflowSourceRef>
}

interface ObservedToolCallRow {
  readonly change: CallChange
  readonly result_json: string | null
}

const decodeSourceRef = Schema.decodeUnknownOption(WorkflowSourceRefSchema)

const sourceRefsFromResult = Effect.fn("ScriptJournal.sourceRefs")(function* (
  resultJson: string | null
) {
  if (resultJson === null) return []
  const result = yield* decodeJson(Schema.Json, resultJson).pipe(Effect.option)
  if (Option.isNone(result)) return []
  const host = Predicate.isObject(result.value) ? result.value["host"] : undefined
  if (!Predicate.isObject(host)) return []
  const sourceRefs: Array<WorkflowSourceRef> = []
  const candidates = host["source_refs"]
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const decoded = decodeSourceRef(candidate)
      if (Option.isSome(decoded)) sourceRefs.push(decoded.value)
    }
  }
  const descriptor = readManagedObjectDescriptor(host["managed_output"])
  if (descriptor !== undefined && !sourceRefs.some((source) => source.ref === descriptor.ref)) {
    sourceRefs.push({
      ...descriptor,
      provider: "arden",
      kind: "managed_output",
      ref: descriptor.ref,
      title: "Localized tool output"
    })
  }
  return boundedSourceRefs(sourceRefs)
})

export const observeChildRunEffects = Effect.fn("ScriptJournal.observeChild")(function* (
  sql: SqlClient.SqlClient,
  runId: string
): Effect.fn.Return<ChildObservation, SqlError.SqlError> {
  const roots = yield* sql<{ readonly session_id: string }>`
    SELECT run.session_id FROM chat_runs AS run WHERE run.run_id = ${runId} LIMIT 1
  `
  const root = roots[0]
  if (root === undefined) return { effectDisposition: "unknown", sourceRefs: [] }
  const subtree = sessionDescendants(sql, {
    name: "subtree",
    from: sql`SELECT ${root.session_id} AS session_id`,
    where: sql`walk.depth > 0 OR child.parent_run_id = ${runId}`,
    depth: { max: 64 }
  })
  const rows = yield* sql<ObservedToolCallRow>`
    WITH RECURSIVE ${subtree}
    SELECT ${callChange(sql)} AS change, call.result_json
    FROM tool_calls AS call
    JOIN subtree ON subtree.session_id = call.session_id
    WHERE call.tool_name <> 'spawn_agent'
      AND (subtree.depth > 0 OR call.run_id = ${runId})
    ORDER BY call.started_at, call.run_id, call.tool_call_id
  `
  let observed: WorkflowEffectDisposition = "none"
  const sourceRefs = new Map<string, WorkflowSourceRef>()
  for (const row of rows) {
    observed = mergeEffectDisposition(observed, callEffect(row.change))
    addSourceRefs(sourceRefs, yield* sourceRefsFromResult(row.result_json))
  }
  const open = yield* sql<{ readonly run_id: string }>`
    WITH RECURSIVE ${subtree}
    SELECT run.run_id FROM chat_runs AS run
    JOIN subtree ON subtree.session_id = run.session_id
    WHERE run.status IN ${activeRunStatusList}
      AND (subtree.depth > 0 OR run.run_id = ${runId})
    UNION ALL
    SELECT json_extract(session.metadata, '$.agent_trace_retained_run_id')
    FROM sessions AS session
    JOIN subtree ON subtree.session_id = session.session_id
    WHERE json_type(session.metadata, '$.agent_trace_retained_run_id') = 'text'
      AND (subtree.depth > 0
        OR json_extract(session.metadata, '$.agent_trace_retained_run_id') = ${runId})
    LIMIT 1
  `
  if (open[0] !== undefined) observed = mergeEffectDisposition(observed, "unknown")
  return { effectDisposition: observed, sourceRefs: [...sourceRefs.values()] }
})

export const activeScriptChildRuns = Effect.fn("ScriptJournal.activeChildRuns")(function* (
  sql: SqlClient.SqlClient,
  origin: { readonly originRunId: string; readonly originToolCallId: string }
): Effect.fn.Return<ReadonlyArray<string>, SqlError.SqlError> {
  const prefix = `${origin.originToolCallId}:workflow:`
  const rows = yield* sql<{ readonly run_id: string }>`
    WITH RECURSIVE ${sessionDescendants(sql, {
      name: "subtree",
      from: sql`SELECT child.session_id FROM sessions AS child
        WHERE child.parent_run_id = ${origin.originRunId}
          AND substr(child.parent_tool_call_id, 1, ${prefix.length}) = ${prefix}`
    })}
    SELECT DISTINCT run.run_id FROM chat_runs AS run
    JOIN subtree ON subtree.session_id = run.session_id
    WHERE run.status IN ${activeRunStatusList}
    ORDER BY run.started_at, run.run_id
  `
  return rows.map((row) => row.run_id)
})
