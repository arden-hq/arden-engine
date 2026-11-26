import { randomUUID } from "node:crypto"
import { captureLearning, procedureInputHash } from "../browser-procedures/model.js"
import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { BrowserProcedureSummary } from "@arden-hq/protocol/browser-procedures"
import { BrowserProcedureStore, BrowserProcedureStoreError } from "../browser-procedures/store.js"
import {
  ProcedurePolicySchema,
  ProcedureSpecSchema,
  ProcedureEvidenceSchema,
  type ProcedureEvidence,
  type StoredProcedure
} from "../browser-procedures/model.js"
import { condenseBrowserRun, type BrowserRunCall } from "../browser-procedures/condense.js"
import { jsonText } from "../json.js"
import type { WriterDeps } from "./deps.js"
import { ACTIVE_RUN_STATUSES } from "@arden-hq/protocol/runs"
import { callChange } from "./run-effects.js"
import { RejectedToolResultSchema } from "../tools/store.js"
import {
  activeRunStatusList,
  eligibleBrowserProcedureStatusList,
  restartCutRunSql,
  resultToolStatusList,
  statusSqlList,
  UNRESOLVED_TOOL_STATUSES
} from "./status-sets.js"
import { fullResultJson } from "./tool-result-storage.js"
import { makeBrowserProcedureJobs } from "./browser-procedure-jobs.js"
import { descendantCalls, descendantCallsOfColumns } from "./detached-workflow-calls.js"

const failure = (cause: unknown) =>
  new BrowserProcedureStoreError({ message: "Could not update browser procedures", cause })
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))
const policyJson = Schema.fromJsonString(ProcedurePolicySchema)
const specJson = Schema.fromJsonString(ProcedureSpecSchema)
const evidenceJson = Schema.fromJsonString(Schema.Array(ProcedureEvidenceSchema))
const jsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
const rejectedResult = Schema.fromJsonString(RejectedToolResultSchema)
const loadRejection = Effect.fn("BrowserProcedures.rejection")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  toolCallId: string
) {
  const rows = yield* sql<{ readonly result_json: string }>`
    SELECT t.result_json FROM tool_calls t
    JOIN tool_approvals a ON a.run_id=t.run_id AND a.tool_call_id=t.tool_call_id
    WHERE t.run_id=${runId} AND t.tool_call_id IN ${descendantCalls(sql, runId, toolCallId)}
      AND a.kind='tool_approval' AND a.status='rejected' AND t.result_json IS NOT NULL`
  for (const row of rows) {
    const parsed = Schema.decodeUnknownOption(rejectedResult)(row.result_json)
    if (parsed._tag === "Some") return { feedback: parsed.value.data.approval.feedback ?? null }
  }
  return undefined
})
interface Row {
  readonly id: string
  readonly origin: string
  readonly profile_ref: string
  readonly name: string
  readonly description: string
  readonly status: StoredProcedure["status"]
  readonly enabled: number
  readonly revision: number
  readonly success_count: number
  readonly failure_count: number
  readonly updated_at: string
  readonly specification_json: string
  readonly evidence_json: string
}
const summary = (row: Row): BrowserProcedureSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  origin: row.origin,
  profile_ref: row.profile_ref,
  status: row.enabled === 1 ? row.status : "disabled",
  revision: row.revision,
  success_count: row.success_count,
  failure_count: row.failure_count,
  updated_at: row.updated_at
})
const decode = Effect.fn("BrowserProcedures.decode")(function* (
  row: Row
): Effect.fn.Return<StoredProcedure, Schema.SchemaError> {
  return {
    id: row.id,
    origin: row.origin,
    profile: row.profile_ref,
    revision: row.revision,
    status: row.status,
    enabled: row.enabled === 1,
    successes: row.success_count,
    failures: row.failure_count,
    updatedAt: row.updated_at,
    spec: yield* Schema.decodeUnknownEffect(specJson)(row.specification_json),
    evidence: yield* Schema.decodeUnknownEffect(evidenceJson)(row.evidence_json)
  }
})

/** A run the check can judge for good: it has ended and nothing in it is
 * still going, so its tool calls cannot change. */
const SETTLED_CANDIDATE_SQL = `r.status NOT IN ${statusSqlList(ACTIVE_RUN_STATUSES)}
    AND NOT EXISTS (SELECT 1 FROM tool_calls t WHERE t.run_id = r.run_id AND t.status IN ${statusSqlList(UNRESOLVED_TOOL_STATUSES)})
    AND NOT EXISTS (SELECT 1 FROM code_mode_scripts s WHERE s.origin_run_id = r.run_id AND s.status = 'running')`

/**
 * Finished runs that used the browser and have no learning job yet. It reads
 * browser_procedure_candidates, the runs with a browser tool call that the
 * check has not judged, and reaches each run by its id. Before, it walked
 * every completed run, after every run and every 30 seconds.
 */
const BROWSER_PROCEDURE_ENQUEUE_SQL = `INSERT OR IGNORE INTO browser_procedure_jobs(id, run_id, status, created_at, updated_at)
  SELECT r.run_id, r.run_id, 'pending', ?, ? FROM browser_procedure_candidates c
  CROSS JOIN chat_runs r ON r.run_id = c.run_id
  WHERE r.status = 'completed' AND r.ended_at >= (SELECT since FROM browser_procedure_settings WHERE singleton = 1)
    AND ${SETTLED_CANDIDATE_SQL}
    AND NOT EXISTS (SELECT 1 FROM browser_procedure_jobs j WHERE j.run_id = r.run_id)
    AND (NOT EXISTS (SELECT 1 FROM browser_procedure_invocations used WHERE used.run_id=r.run_id AND used.status='succeeded')
      OR EXISTS (SELECT 1 FROM tool_calls extra WHERE extra.run_id=r.run_id
        AND extra.tool_name IN ('browser_open','browser_snapshot','browser_act','browser_wait')
        AND (extra.tool_name='browser_act' OR extra.started_at>(SELECT MIN(used.created_at) FROM browser_procedure_invocations used WHERE used.run_id=r.run_id AND used.status='succeeded'))
        AND NOT EXISTS (SELECT 1 FROM browser_procedure_invocations used WHERE used.run_id=r.run_id AND used.status='succeeded' AND extra.tool_call_id IN ${descendantCallsOfColumns("used.run_id", "used.tool_call_id")})))
  ORDER BY r.ended_at DESC`

/** Drops every judged run from the list: a settled run has its job by now or
 * will never get one, so the list holds only runs still going. */
const BROWSER_PROCEDURE_SETTLE_SQL = `DELETE FROM browser_procedure_candidates
  WHERE run_id IN (SELECT c.run_id FROM browser_procedure_candidates c
    CROSS JOIN chat_runs r ON r.run_id = c.run_id WHERE ${SETTLED_CANDIDATE_SQL})`

export const makeBrowserProcedureStore = (deps: WriterDeps): BrowserProcedureStore["Service"] => {
  const { writer } = deps
  const { sql, reader } = writer
  const enabled = reader<{
    readonly enabled: number
  }>`SELECT enabled FROM browser_procedure_settings WHERE singleton = 1`.pipe(
    Effect.map((rows) => rows[0]?.enabled === 1)
  )
  const mayHaveChanged = Effect.fn("BrowserProcedures.mayHaveChanged")(function* (
    runId: string,
    toolCallId: string
  ) {
    const rows = yield* reader<{ readonly changed: number }>`SELECT EXISTS (
      SELECT 1 FROM tool_calls AS call WHERE call.run_id=${runId}
        AND call.tool_call_id IN ${descendantCalls(reader, runId, toolCallId)}
        AND ${callChange(reader)} != 'none'
    ) changed`
    return rows[0]?.changed === 1
  })
  const acted = Effect.fn("BrowserProcedures.acted")(function* (runId: string, toolCallId: string) {
    const rows = yield* reader<{ readonly acted: number }>`SELECT EXISTS (
      SELECT 1 FROM tool_calls AS call WHERE call.run_id=${runId}
        AND call.tool_call_id IN ${descendantCalls(reader, runId, toolCallId)}
        AND call.tool_name='browser_act'
    ) acted`
    return rows[0]?.acted === 1
  })
  const get = Effect.fn("BrowserProcedures.get")(function* (id: string) {
    const rows =
      yield* reader<Row>`SELECT p.*, r.specification_json, r.evidence_json FROM browser_procedures p
      JOIN browser_procedure_revisions r ON r.procedure_id = p.id AND r.revision = p.revision WHERE p.id = ${id}`
    return rows[0] === undefined ? undefined : yield* decode(rows[0])
  })
  const list = Effect.fn("BrowserProcedures.list")(function* () {
    const procedures =
      yield* reader<Row>`SELECT * FROM browser_procedures ORDER BY updated_at DESC LIMIT 500`
    const jobs = yield* reader<{
      readonly id: string
      readonly status: "pending" | "running" | "failed"
      readonly error: string | null
    }>`
      SELECT id, status, error FROM browser_procedure_jobs WHERE status <> 'completed' ORDER BY created_at DESC LIMIT 30`
    return {
      enabled: yield* enabled,
      procedures: procedures.map(summary),
      jobs: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        ...(job.error === null ? {} : { error: job.error })
      }))
    }
  })
  const eligible = Effect.fn("BrowserProcedures.eligible")(function* (
    origin: string,
    profile: string
  ) {
    if (!(yield* enabled)) return []
    const rows =
      yield* reader<Row>`SELECT p.*, r.specification_json, r.evidence_json FROM browser_procedures p
      JOIN browser_procedure_revisions r ON r.procedure_id = p.id AND r.revision = p.revision
      WHERE p.origin = ${origin} AND p.profile_ref = ${profile} AND p.enabled = 1
        AND p.status IN ${eligibleBrowserProcedureStatusList} ORDER BY p.success_count DESC LIMIT 25`
    return yield* Effect.forEach(rows, decode)
  })
  const enable = Effect.fn("BrowserProcedures.enable")(function* (value: boolean, id?: string) {
    if (id === undefined)
      yield* writer.run(
        sql`UPDATE browser_procedure_settings SET enabled = ${value ? 1 : 0} WHERE singleton = 1`
      )
    else
      yield* writer.run(
        sql`UPDATE browser_procedures SET enabled = ${value ? 1 : 0} WHERE id = ${id}`
      )
  })
  const enqueue = Effect.fn("BrowserProcedures.enqueue")(function* () {
    // Nothing waits: the usual case, answered by a read of an empty table.
    const waiting = yield* reader<{
      readonly waiting: number
    }>`SELECT 1 AS waiting FROM browser_procedure_candidates LIMIT 1`
    if (waiting.length === 0) return
    const learning = yield* enabled
    const at = yield* now
    yield* writer.transact(
      Effect.gen(function* () {
        if (learning) yield* sql.unsafe(BROWSER_PROCEDURE_ENQUEUE_SQL, [at, at])
        yield* sql.unsafe(BROWSER_PROCEDURE_SETTLE_SQL)
      })
    )
  })
  const recordOutcome = Effect.fn("BrowserProcedures.recordOutcome")(function* (
    runId: string,
    outcome: "saved" | "skipped",
    reason: string
  ) {
    yield* writer.run(sql`UPDATE browser_procedure_jobs
      SET outcome = ${outcome}, outcome_reason = ${reason.trim().slice(0, 2000) || "No reason given."}
      WHERE run_id = ${runId}`)
  })
  const evidence = Effect.fn("BrowserProcedures.evidence")(function* (
    runId: string
  ): Effect.fn.Return<ProcedureEvidence | undefined, unknown> {
    const sensitive = yield* reader<{
      readonly blocked: number
    }>`SELECT EXISTS(SELECT 1 FROM tool_calls WHERE run_id=${runId} AND (tool_name='browser_ask_secret' OR (tool_name='browser_act' AND json_type(arguments_json,'$.secret') IS NOT NULL))) blocked`
    if (sensitive[0]?.blocked === 1) return undefined
    const runs = yield* reader<{
      readonly session_id: string
      readonly ended_at: string
    }>`
      SELECT r.session_id, r.ended_at
      FROM chat_runs r WHERE r.run_id = ${runId} AND r.status = 'completed'`
    const run = runs[0]
    if (run === undefined) return undefined
    const rows = yield* reader<{
      readonly tool_call_id: string
      readonly tool_name: string
      readonly arguments_json: string
      readonly result_json: string
      readonly changes_state: number
      readonly change: "none" | "arden" | "applied" | "uncertain"
    }>`
      SELECT tool_call_id,tool_name,arguments_json,result_json,changes_state,${callChange(reader)} change FROM tool_calls AS call
      WHERE run_id = ${runId} AND tool_name IN ('browser_open','browser_snapshot','browser_act','browser_wait')
        AND status = 'completed' AND result_json IS NOT NULL
      ORDER BY started_at,tool_call_id`
    const calls: Array<BrowserRunCall> = []
    for (const row of rows) {
      const resultJson = yield* writer.withToolResults(fullResultJson(row.result_json))
      const raw = yield* Schema.decodeUnknownEffect(jsonObject)(resultJson)
      const learning = captureLearning(raw["data"])
      if (learning === "sensitive") return undefined
      if (raw["is_error"] === true && row.change === "none") continue
      if (learning === "unmarked") return undefined
      const args = yield* Schema.decodeUnknownEffect(jsonObject)(row.arguments_json)
      const data = Schema.decodeUnknownOption(jsonObject.to)(raw["data"])
      calls.push({
        id: row.tool_call_id,
        name: row.tool_name,
        args,
        content: jsonText(raw["content"]),
        data: data._tag === "None" ? {} : data.value,
        isError: raw["is_error"] === true,
        changesState: row.changes_state === 1,
        pageChecked: learning === "safe"
      })
    }
    if (calls.length === 0) return undefined
    const condensed = condenseBrowserRun(calls)
    return {
      run_id: runId,
      session_id: run.session_id,
      completed_at: run.ended_at,
      ...condensed
    }
  })
  const publish: BrowserProcedureStore["Service"]["publish"] = (input) =>
    writer
      .transact(
        Effect.gen(function* () {
          const id = input.id ?? `bp-${randomUUID()}`
          const old = yield* sql<{
            readonly revision: number
          }>`SELECT revision FROM browser_procedures WHERE id = ${id}`
          const revision = (old[0]?.revision ?? 0) + 1
          const at = yield* now
          const spec = yield* Schema.encodeEffect(specJson)(input.spec)
          const evidence = yield* Schema.encodeEffect(evidenceJson)(input.evidence.slice(-5))
          yield* sql`INSERT INTO browser_procedures(id,origin,profile_ref,name,description,status,revision,updated_at)
      VALUES (${id},${input.origin},${input.profile},${input.spec.name},${input.spec.description},'candidate',${revision},${at})
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,status='candidate',revision=excluded.revision,updated_at=excluded.updated_at`
          yield* sql`INSERT INTO browser_procedure_revisions(procedure_id,revision,specification_json,evidence_json,created_at) VALUES (${id},${revision},${spec},${evidence},${at})`
          return id
        })
      )
      .pipe(Effect.mapError(failure))
  const invocation = Effect.fn("BrowserProcedures.invocation")(function* (
    runId: string,
    parentToolCallId: string
  ) {
    const rows = yield* reader<
      Row & { readonly input_json: string; readonly tool_call_id: string; readonly tab_ref: string }
    >`SELECT p.id,p.origin,p.profile_ref,p.name,p.description,p.status,p.enabled,i.revision,p.success_count,p.failure_count,p.updated_at,r.specification_json,r.evidence_json,i.input_json,i.tool_call_id,i.tab_ref FROM browser_procedure_invocations i JOIN browser_procedures p ON p.id=i.procedure_id JOIN browser_procedure_revisions r ON r.procedure_id=i.procedure_id AND r.revision=i.revision WHERE i.run_id=${runId} AND i.parent_tool_call_id=${parentToolCallId}`
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      procedure: yield* decode(row),
      input: yield* Schema.decodeUnknownEffect(jsonObject)(row.input_json),
      toolCallId: row.tool_call_id,
      tab: row.tab_ref
    }
  })
  const begin: BrowserProcedureStore["Service"]["begin"] = (input) =>
    now.pipe(
      Effect.flatMap((at) =>
        writer.run(sql`INSERT OR IGNORE INTO browser_procedure_invocations(run_id,tool_call_id,parent_tool_call_id,input_json,policy_json,procedure_id,revision,input_hash,tab_ref,status,created_at)
    VALUES (${input.runId},${input.toolCallId},${input.parentToolCallId},${JSON.stringify(input.input)},${JSON.stringify(input.policy)},${input.procedure.id},${input.procedure.revision},${procedureInputHash(input.input)},${input.tab},'running',${at})`)
      ),
      Effect.asVoid,
      Effect.mapError(failure)
    )
  const settle = Effect.fn("BrowserProcedures.settle")(function* (
    runId: string,
    toolCallId: string,
    status: "succeeded" | "failed" | "uncertain" | "not_applicable"
  ) {
    yield* writer.transact(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly procedure_id: string
          readonly revision: number
        }>`SELECT procedure_id,revision FROM browser_procedure_invocations WHERE run_id=${runId} AND tool_call_id=${toolCallId} AND status='running'`
        const row = rows[0]
        if (row === undefined) return
        const at = yield* now
        const rejected = yield* loadRejection(sql, runId, toolCallId)
        yield* sql`UPDATE browser_procedure_invocations SET status=${rejected === undefined ? status : "failed"},ended_at=${at} WHERE run_id=${runId} AND tool_call_id=${toolCallId}`
        if (rejected !== undefined || status === "not_applicable") return
        yield* sql`UPDATE browser_procedures SET status=CASE WHEN status='suspended' THEN 'suspended' WHEN ${status === "succeeded" ? 1 : 0} THEN 'accepted' ELSE 'suspended' END,
        success_count=success_count+${status === "succeeded" ? 1 : 0}, failure_count=failure_count+${status === "succeeded" ? 0 : 1},updated_at=${at}
        WHERE id=${row.procedure_id} AND revision=${row.revision}`
      })
    )
  })
  const reconcile = Effect.fn("BrowserProcedures.reconcile")(function* () {
    const rows = yield* reader<{
      readonly run_id: string
      readonly tool_call_id: string
      readonly status: string
      readonly result_json: string | null
    }>`SELECT i.run_id,i.tool_call_id,t.status,t.result_json FROM browser_procedure_invocations i JOIN tool_calls t ON t.run_id=i.run_id AND t.tool_call_id=i.tool_call_id WHERE i.status='running' AND t.status IN ${resultToolStatusList}`
    for (const row of rows) {
      const resultJson =
        row.result_json === null
          ? null
          : yield* writer.withToolResults(fullResultJson(row.result_json))
      const value =
        resultJson === null ? undefined : yield* Schema.decodeUnknownEffect(jsonObject)(resultJson)
      const outcome = Schema.decodeUnknownOption(
        Schema.Struct({
          data: Schema.Struct({
            value: Schema.Struct({ procedure_verified: Schema.Literal(true) })
          })
        })
      )(value)
      const receipt = Schema.decodeUnknownOption(
        Schema.Struct({
          data: Schema.Struct({ detached: Schema.Struct({ workflow_ref: Schema.String }) })
        })
      )(value)
      if (receipt._tag === "Some") {
        const scripts = yield* reader<{
          readonly status: string
          readonly body: string | null
        }>`SELECT s.status,d.body FROM code_mode_scripts s
          LEFT JOIN automation_deliveries d ON json_extract(d.payload,'$.kind')='script_result' AND json_extract(d.payload,'$.workflowRef')=s.script_ref AND json_extract(d.payload,'$.attempt')=s.attempt
          WHERE s.origin_run_id=${row.run_id} AND s.origin_tool_call_id=${row.tool_call_id} LIMIT 1`
        const script = scripts[0]
        if (script === undefined || script.status === "running") continue
        const result =
          script.body === null
            ? undefined
            : Schema.decodeUnknownOption(
                Schema.fromJsonString(Schema.Struct({ procedure_verified: Schema.Literal(true) }))
              )(script.body)
        yield* settle(
          row.run_id,
          row.tool_call_id,
          script.status === "succeeded" && result?._tag === "Some" ? "succeeded" : "uncertain"
        )
        continue
      }
      const changed = yield* mayHaveChanged(row.run_id, row.tool_call_id)
      const failureStatus = row.status === "uncertain" || changed ? "uncertain" : "failed"
      yield* settle(
        row.run_id,
        row.tool_call_id,
        row.status !== "uncertain" && outcome._tag === "Some" ? "succeeded" : failureStatus
      )
    }
  })
  const scope = Effect.fn("BrowserProcedures.scope")(function* (runId: string, callId: string) {
    const rows = yield* reader<{
      readonly origin: string
      readonly profile_ref: string
      readonly tab_ref: string
      readonly read_only: number
      readonly calls: number
      readonly replay: number
      readonly policy_json: string
      readonly tool_call_id: string
    }>`SELECT p.origin,p.profile_ref,i.tab_ref,i.read_only,i.policy_json,i.tool_call_id,(SELECT COUNT(*) FROM tool_calls t WHERE t.run_id=i.run_id AND t.tool_call_id IN ${descendantCalls(reader, reader`i.run_id`, reader`i.tool_call_id`)} AND t.tool_call_id<>${callId} AND t.tool_name IN ('browser_snapshot','browser_act','browser_wait','browser_open')) calls,EXISTS(SELECT 1 FROM tool_calls completed WHERE completed.run_id=i.run_id AND completed.tool_call_id=${callId} AND completed.status='completed') replay FROM browser_procedure_invocations i JOIN browser_procedures p ON p.id=i.procedure_id
      WHERE i.run_id=${runId} AND (${callId}=i.tool_call_id OR ${callId} IN ${descendantCalls(reader, reader`i.run_id`, reader`i.tool_call_id`)}) ORDER BY length(i.tool_call_id) DESC LIMIT 1`
    const row = rows[0]
    return row === undefined
      ? undefined
      : {
          origin: row.origin,
          profile: row.profile_ref,
          tab: row.tab_ref,
          readOnly: row.read_only === 1,
          calls: row.calls,
          replay: row.replay === 1,
          rejected: (yield* loadRejection(reader, runId, row.tool_call_id)) !== undefined,
          policy: yield* Schema.decodeUnknownEffect(policyJson)(row.policy_json)
        }
  })
  const tabOwner = Effect.fn("BrowserProcedures.tabOwner")(function* (tabRef: string) {
    const rows = yield* reader<{
      readonly run_id: string
      readonly parent_tool_call_id: string
      readonly tool_call_id: string
    }>`SELECT i.run_id,i.parent_tool_call_id,i.tool_call_id FROM browser_procedure_invocations i JOIN chat_runs r ON r.run_id=i.run_id LEFT JOIN code_mode_scripts s ON s.origin_run_id=i.run_id AND s.origin_tool_call_id=i.tool_call_id WHERE i.tab_ref=${tabRef} AND i.status='running' AND (s.status='running' OR (s.script_ref IS NULL AND (r.status IN ${activeRunStatusList} OR ${restartCutRunSql("r")}))) ORDER BY i.created_at LIMIT 1`
    const row = rows[0]
    return row === undefined
      ? undefined
      : {
          runId: row.run_id,
          parentToolCallId: row.parent_tool_call_id,
          toolCallId: row.tool_call_id
        }
  })
  const readOnly = (runId: string, callId: string) =>
    writer
      .run(
        sql`UPDATE browser_procedure_invocations SET read_only=1 WHERE run_id=${runId} AND (${callId}=tool_call_id OR ${callId} IN ${descendantCalls(sql, sql`browser_procedure_invocations.run_id`, sql`browser_procedure_invocations.tool_call_id`)})`
      )
      .pipe(Effect.asVoid)
  return BrowserProcedureStore.of({
    jobs: makeBrowserProcedureJobs(deps, enabled),
    tabOwner: (tabRef) => tabOwner(tabRef).pipe(Effect.mapError(failure)),
    rejection: (runId, toolCallId) =>
      loadRejection(reader, runId, toolCallId).pipe(Effect.mapError(failure)),
    invocation: (runId, parentToolCallId) =>
      invocation(runId, parentToolCallId).pipe(Effect.mapError(failure)),
    scope: (runId, callId) => scope(runId, callId).pipe(Effect.mapError(failure)),
    readOnly: (runId, callId) => readOnly(runId, callId).pipe(Effect.mapError(failure)),
    acted: (runId, toolCallId) => acted(runId, toolCallId).pipe(Effect.mapError(failure)),
    mayHaveChanged: (runId, toolCallId) =>
      mayHaveChanged(runId, toolCallId).pipe(Effect.mapError(failure)),
    get: (id) => get(id).pipe(Effect.mapError(failure)),
    list: () => list().pipe(Effect.mapError(failure)),
    eligible: (origin, profile) => eligible(origin, profile).pipe(Effect.mapError(failure)),
    enable: (value, id) => enable(value, id).pipe(Effect.mapError(failure)),
    enqueue: () => enqueue().pipe(Effect.mapError(failure)),
    recordOutcome: (runId, outcome, reason) =>
      recordOutcome(runId, outcome, reason).pipe(Effect.mapError(failure)),
    evidence: (runId) => evidence(runId).pipe(Effect.mapError(failure)),
    publish,
    begin,
    settle: (runId, toolCallId, status) =>
      settle(runId, toolCallId, status).pipe(Effect.mapError(failure)),
    reconcile: () => reconcile().pipe(Effect.mapError(failure))
  })
}
