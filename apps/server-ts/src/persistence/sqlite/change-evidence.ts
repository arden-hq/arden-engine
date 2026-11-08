import type { ToolResult } from "@arden-hq/loop"
import { CODE_MODE_TOOL, NESTED_CALL_MARKERS } from "../tools/tool-roles.js"
import { Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { projectChangeEvidence, stripChangeEvidence } from "../tools/change-evidence.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { readEffectTargets, readEffectTargetsOf } from "./effect-targets.js"
import {
  readMutationChildren,
  readMutationChildrenOf,
  readMutationVersions,
  readMutationVersionsOf
} from "./mutation-links.js"
import type { ChangeEvidence } from "../tools/change-evidence.js"
import { JsonObjectSchema } from "../json.js"
import { resultToolStatusList } from "./status-sets.js"
import { WorkflowStatusSchema } from "@arden-hq/protocol/effect/workflows"

export const refreshChangeEvidence = Effect.fn("ChangeEvidence.refresh")(function* (
  sql: SqlClient.SqlClient,
  identity: MutationOperationIdentity & { readonly changesState: boolean },
  result: ToolResult
) {
  const clean = stripChangeEvidence(result)
  return identity.changesState ? yield* withChangeEvidence(sql, identity, clean) : clean
})

interface NestedCall {
  readonly tool_call_id: string
  readonly name: string
  readonly status: "completed" | "failed"
  readonly source_refs?: Schema.Json
  readonly change_evidence?: ChangeEvidence
}

export type NestedCalls = ReadonlyMap<string, NestedCall>

export const withNestedCallFacts = Effect.fn("ChangeEvidence.nestedCalls")(function* <
  Data extends Readonly<Record<string, unknown>>
>(
  sql: SqlClient.SqlClient,
  script: MutationOperationIdentity,
  data: Data,
  marker: string = NESTED_CALL_MARKERS[CODE_MODE_TOOL]
) {
  return withCallFacts(yield* readNestedCallFacts(sql, script, marker), data)
})

export const withCallFacts = <Data extends Readonly<Record<string, unknown>>>(
  calls: NestedCalls,
  data: Data
) => {
  const tools = data["tools"]
  if (Array.isArray(tools)) {
    return {
      ...data,
      tools: tools.map((tool) => {
        if (!Predicate.isObject(tool)) return tool
        const { source_refs: _sources, change_evidence: _changes, ...entry } = tool
        const call = Predicate.isString(tool["tool_call_id"])
          ? calls.get(tool["tool_call_id"])
          : undefined
        return call === undefined ? entry : { ...entry, ...factsOf(call) }
      })
    }
  }
  const listed = [...calls.values()].filter(
    (call) => call.source_refs !== undefined || call.change_evidence !== undefined
  )
  return listed.length === 0 ? data : { ...data, nested_calls: listed }
}

const factsOf = (call: NestedCall) => ({
  ...(call.source_refs === undefined ? {} : { source_refs: call.source_refs }),
  ...(call.change_evidence === undefined ? {} : { change_evidence: call.change_evidence })
})

const decodeSources = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))
const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObjectSchema))

export const readNestedCallFacts = Effect.fn("ChangeEvidence.readNestedCallFacts")(function* (
  sql: SqlClient.SqlClient,
  script: MutationOperationIdentity,
  marker: string = NESTED_CALL_MARKERS[CODE_MODE_TOOL]
) {
  const prefix = `${script.toolCallId}${marker}`
  const rows = yield* sql<{
    readonly tool_call_id: string
    readonly tool_name: string
    readonly changes_state: number
    readonly source_refs: string | null
    readonly is_error: number | null
    readonly host: string | null
    readonly applied_change: string | null
  }>`
    SELECT tool_call_id, tool_name, changes_state,
      json_extract(result_json, '$.data.source_refs') AS source_refs,
      json_extract(result_json, '$.is_error') AS is_error,
      CASE WHEN changes_state = 1 THEN json_extract(result_json, '$.host') END AS host,
      CASE WHEN changes_state = 1
        THEN json_extract(result_json, '$.data.applied_change') END AS applied_change
    FROM tool_calls
    WHERE run_id = ${script.runId}
      AND tool_call_id > ${prefix} AND tool_call_id < ${`${prefix.slice(0, -1)};`}
      AND status IN ${resultToolStatusList}
      AND result_json IS NOT NULL
      -- A row whose result will not parse names nothing; the rest still count.
      AND json_valid(result_json)
    ORDER BY started_at, tool_call_id
  `
  const writes = rows.flatMap((row) => {
    if (row.changes_state !== 1) return []
    const host = row.host === null ? Option.none() : decodeObject(row.host)
    const applied = row.applied_change === null ? Option.none() : decodeObject(row.applied_change)
    const result: ToolResult = {
      content: "",
      preview: "",
      ...(Option.isSome(host) ? { host: host.value } : {}),
      ...(Option.isSome(applied) ? { data: { applied_change: applied.value } } : {})
    }
    return [{ toolCallId: row.tool_call_id, result }]
  })
  const evidence = yield* changeEvidenceOfCalls(sql, script.runId, writes)
  const calls = new Map<string, NestedCall>()
  for (const row of rows) {
    const sources = row.source_refs === null ? Option.none() : decodeSources(row.source_refs)
    const changes = evidence.get(row.tool_call_id)
    calls.set(row.tool_call_id, {
      tool_call_id: row.tool_call_id,
      name: row.tool_name,
      status: row.is_error === 1 ? "failed" : "completed",
      ...(Option.isSome(sources) ? { source_refs: sources.value } : {}),
      ...(changes === undefined ? {} : { change_evidence: changes })
    })
  }
  return calls
})

const decodePatch = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("file_edit"),
    patch: Schema.String,
    truncated: Schema.Boolean
  })
)

export const withChangeEvidence = Effect.fn("ChangeEvidence.project")(function* (
  sql: SqlClient.SqlClient,
  identity: MutationOperationIdentity,
  result: ToolResult
) {
  const links = yield* readMutationVersions(sql, identity)
  const children = yield* readMutationChildren(sql, identity)
  const targets = yield* readEffectTargets(sql, identity)
  return {
    ...result,
    data: { ...result.data, change_evidence: projected(identity, result, links, children, targets) }
  } satisfies ToolResult
})

const changeEvidenceOfCalls = Effect.fn("ChangeEvidence.projectMany")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  calls: ReadonlyArray<{ readonly toolCallId: string; readonly result: ToolResult }>
) {
  const ids = calls.map((call) => call.toolCallId)
  const links = yield* readMutationVersionsOf(sql, runId, ids)
  const children = yield* readMutationChildrenOf(sql, runId, ids)
  const targets = yield* readEffectTargetsOf(sql, runId, ids)
  return new Map(
    calls.map(({ toolCallId, result }) => [
      toolCallId,
      projected(
        { runId, toolCallId },
        result,
        links.get(toolCallId) ?? { entries: [], omitted: 0 },
        children.get(toolCallId) ?? { runs: [], truncated: false },
        targets.get(toolCallId) ?? []
      )
    ])
  )
})

const projected = (
  identity: MutationOperationIdentity,
  result: ToolResult,
  links: Pick<Parameters<typeof projectChangeEvidence>[0], "entries" | "omitted">,
  children: Parameters<typeof projectChangeEvidence>[0]["children"],
  targets: Parameters<typeof projectChangeEvidence>[0]["targets"]
): ChangeEvidence => {
  const patch = Option.getOrUndefined(decodePatch(result.data?.applied_change))
  const availableComparison = patch?.truncated === true ? "truncated" : "patch"
  const fileComparison = patch === undefined ? "unavailable" : availableComparison
  return projectChangeEvidence({
    identity,
    host: result.host,
    ...links,
    children,
    fileComparison,
    targets
  })
}

export const withScriptState = Effect.fn("ChangeEvidence.scriptState")(function* <
  Data extends Readonly<Record<string, unknown>>
>(sql: SqlClient.SqlClient, data: Data) {
  const detached = data["detached"]
  if (!Predicate.isObject(detached) || !Predicate.isString(detached["workflow_ref"])) return data
  const rows = yield* sql<{
    readonly status: string
    readonly version: number
    readonly attempt: number
  }>`SELECT status, version, attempt FROM code_mode_scripts
     WHERE script_ref = ${detached["workflow_ref"]} LIMIT 1`
  const row = rows[0]
  if (row === undefined || !Schema.is(WorkflowStatusSchema)(row.status)) return data
  return {
    ...data,
    detached: { ...detached, status: row.status, version: row.version, attempt: row.attempt }
  }
})
