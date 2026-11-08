import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ManagedOutputs } from "../src/artifacts/managed-output/managed-output.js"
import { stopRun } from "../src/chat/run-stop.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { DeferredToolCalls } from "../src/persistence/tools/deferred.js"
import { ScriptStore } from "../src/persistence/scripts/store.js"
import { revokeAutomationWork } from "../src/persistence/sqlite/automation-authority.js"
import { fenceRunCancellation } from "../src/persistence/sqlite/run-cancellation.js"
import { runGoogleAccounts } from "../src/persistence/sqlite/run-google-accounts.js"
import { readRunLiveness } from "../src/persistence/sqlite/run-liveness.js"
import { assertRunTaskAuthority } from "../src/persistence/sqlite/run-task-authority.js"
import { ScriptRunner } from "../src/workflows/script-runner.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { inUnitOfWork } from "./fixtures/unit-of-work.js"
import { partialService } from "./kit.js"

const AT = "2026-10-30T16:21:05.000Z"
const ENDED = "2026-10-30T16:21:21.000Z"

const seedChat = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type)
      VALUES ('session-1', 'chat~1', ${AT}, ${AT}, 'chat')`
    yield* sql`INSERT INTO execution_budgets (budget_id) VALUES ('budget-1')`
  })

const seedRun = (
  sql: SqlClient.SqlClient,
  run: {
    readonly id: string
    readonly status: "pending" | "running" | "completed" | "interrupted"
    readonly metadata?: object
  }
) =>
  sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, ended_at,
      stop_reason, metadata_json, assistant_message_id)
    VALUES (${run.id}, 'session-1', ${run.status}, ${AT}, ${ENDED},
      ${run.status === "running" || run.status === "pending" ? null : ENDED},
      ${run.status === "interrupted" ? "server_restart" : null},
      json_patch(json_object('run_policy', json_object(
        'budget_id', 'budget-1',
        'execution', json_object('mode', 'inline', 'observe', json('false')),
        'capabilities', json_array('all'),
        'auto_approve', json('false'),
        'google_accounts', NULL,
        'space', NULL)), ${JSON.stringify(run.metadata ?? {})}),
      ${`assistant-${run.id}`})`

const seedApprovedCard = (sql: SqlClient.SqlClient, runId: string) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO tool_calls (run_id, session_id, tool_call_id, tool_name,
        arguments_json, changes_state, status, result_json, started_at, ended_at)
      VALUES (${runId}, 'session-1', 'card', 'calendar_create_event', '{}', 1, 'paused', NULL,
        ${AT}, ${AT})`
    yield* sql`INSERT INTO deferred_tool_calls (run_id, session_id, tool_call_id, tool_name,
        action, scope, arguments_json, changes_state, status, requested_at, resolved_at)
      VALUES (${runId}, 'session-1', 'card', 'calendar_create_event', 'write', 'calendar', '{}',
        1, 'approved', ${AT}, ${ENDED})`
  })

const seedPendingCard = (sql: SqlClient.SqlClient, runId: string) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO tool_calls (run_id, session_id, tool_call_id, tool_name,
        arguments_json, changes_state, status, result_json, started_at, ended_at)
      VALUES (${runId}, 'session-1', 'card', 'calendar_create_event', '{}', 1, 'paused', NULL,
        ${AT}, ${AT})`
    yield* sql`INSERT INTO deferred_tool_calls (run_id, session_id, tool_call_id, tool_name,
        action, scope, arguments_json, changes_state, status, requested_at)
      VALUES (${runId}, 'session-1', 'card', 'calendar_create_event', 'write', 'calendar', '{}',
        1, 'pending', ${AT})`
  })

const fencedRuns = (sql: SqlClient.SqlClient) =>
  sql`SELECT json_extract(data_json, '$.run_id') AS run_id FROM journal_records
    WHERE event_type = 'run_fenced' ORDER BY sequence`

const seedScript = (sql: SqlClient.SqlClient, runId: string) =>
  sql`INSERT INTO code_mode_scripts (script_ref, origin_session_ref, origin_run_id,
      origin_tool_call_id, profile_hash, status, version, attempt, created_at, updated_at)
    VALUES (${`wf-${runId}`}, 'chat~1', ${runId}, 'call-script', 'profile', 'running', 1, 1,
      ${AT}, ${AT})`

it("a Run holds its Google grants while it runs or owns a live script, and Stop ends them", async () => {
  const granted = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seedChat(sql)
      yield* seedRun(sql, { id: "turn-running", status: "running" })
      yield* seedRun(sql, { id: "turn-ended-script-running", status: "completed" })
      yield* seedScript(sql, "turn-ended-script-running")
      yield* seedRun(sql, { id: "turn-ended-card-approved", status: "completed" })
      yield* seedApprovedCard(sql, "turn-ended-card-approved")
      yield* seedRun(sql, { id: "turn-ended-nothing-left", status: "completed" })
      yield* seedRun(sql, { id: "turn-stopped", status: "running" })
      yield* seedScript(sql, "turn-stopped")
      yield* inUnitOfWork(
        fenceRunCancellation({
          sql,
          sessionEvents: yield* SessionLifecycleEvents,
          runId: "turn-stopped",
          now: ENDED
        })
      )
      return {
        running: yield* runGoogleAccounts(sql, "turn-running", "calendar"),
        scriptRunning: yield* runGoogleAccounts(sql, "turn-ended-script-running", "calendar"),
        cardApproved: yield* runGoogleAccounts(sql, "turn-ended-card-approved", "calendar"),
        nothingLeft: yield* runGoogleAccounts(sql, "turn-ended-nothing-left", "calendar"),
        stopped: yield* runGoogleAccounts(sql, "turn-stopped", "calendar")
      }
    })
  )
  expect(granted).toEqual({
    running: null,
    scriptRunning: null,
    cardApproved: null,
    nothingLeft: [],
    stopped: []
  })
})

it("one rule decides whether a Run may still act: its turn, or work it started, until revoked", async () => {
  const state = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seedChat(sql)
      yield* seedRun(sql, { id: "parked-for-approval", status: "pending" })
      yield* seedRun(sql, { id: "script-after-turn", status: "completed" })
      yield* seedScript(sql, "script-after-turn")
      yield* seedRun(sql, { id: "script-after-restart", status: "interrupted" })
      yield* seedScript(sql, "script-after-restart")
      yield* seedRun(sql, { id: "card-awaiting-answer", status: "completed" })
      yield* seedPendingCard(sql, "card-awaiting-answer")
      yield* seedRun(sql, { id: "nothing-left", status: "completed" })
      yield* sql`INSERT INTO execution_budgets (budget_id, token_limit, tokens_used)
        VALUES ('budget-spent', 10, 10)`
      yield* seedRun(sql, {
        id: "budget-spent",
        status: "completed",
        metadata: { run_policy: { budget_id: "budget-spent" } }
      })
      yield* seedScript(sql, "budget-spent")
      yield* sql`INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner,
          created_at, updated_at)
        VALUES ('task-1', NULL, 'reply', 'Reply', 'done', 'worker', ${AT}, ${AT})`
      yield* seedRun(sql, {
        id: "task-closed",
        status: "completed",
        metadata: { run_context: { task: { item_id: "task-1", generation: 0 } } }
      })
      yield* seedScript(sql, "task-closed")
      yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at,
          updated_at, archived_at)
        VALUES ('space-1', 'Space', 'space', '{"enabled":false}', ${AT}, ${AT}, ${ENDED})`
      yield* seedRun(sql, {
        id: "space-archived",
        status: "completed",
        metadata: { run_policy: { space: { space_id: "space-1", generation: 0 } } }
      })
      yield* seedScript(sql, "space-archived")
      yield* seedRun(sql, { id: "stopped-with-script", status: "completed" })
      yield* seedScript(sql, "stopped-with-script")
      yield* inUnitOfWork(
        fenceRunCancellation({
          sql,
          sessionEvents: yield* SessionLifecycleEvents,
          runId: "stopped-with-script",
          now: ENDED
        })
      )
      const runIds = [
        "parked-for-approval",
        "script-after-turn",
        "script-after-restart",
        "card-awaiting-answer",
        "nothing-left",
        "budget-spent",
        "task-closed",
        "space-archived",
        "stopped-with-script"
      ] as const
      const read = Effect.fn(function* (runId: string) {
        const taskChange = yield* assertRunTaskAuthority(sql, runId).pipe(
          Effect.as("allowed"),
          Effect.catch(() => Effect.succeed("refused"))
        )
        return [runId, { liveness: yield* readRunLiveness(sql, runId), taskChange }] as const
      })
      return Object.fromEntries(yield* Effect.forEach(runIds, read))
    })
  )
  expect(state).toEqual({
    "parked-for-approval": { liveness: "turn", taskChange: "allowed" },
    "script-after-turn": { liveness: "background", taskChange: "allowed" },
    "script-after-restart": { liveness: "background", taskChange: "allowed" },
    "card-awaiting-answer": { liveness: "background", taskChange: "allowed" },
    "nothing-left": { liveness: "ended", taskChange: "refused" },
    "budget-spent": { liveness: "revoked", taskChange: "refused" },
    "task-closed": { liveness: "revoked", taskChange: "refused" },
    "space-archived": { liveness: "revoked", taskChange: "refused" },
    "stopped-with-script": { liveness: "revoked", taskChange: "refused" }
  })
})

it("Stop on a Run whose turn ended stops its script, closes its approved card and ends its grants", async () => {
  const state = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seedChat(sql)
      yield* seedRun(sql, { id: "turn-ended", status: "completed" })
      yield* seedScript(sql, "turn-ended")
      yield* seedApprovedCard(sql, "turn-ended")
      const before = yield* runGoogleAccounts(sql, "turn-ended", "calendar")
      const stopped = yield* (yield* ChatWriteStore).stopEndedWork({ sessionId: "session-1" })
      yield* Effect.gen(function* () {
        yield* (yield* ScriptRunner).cancelFenced({ cancelAgent: async () => undefined })
      }).pipe(
        Effect.provide(
          ScriptRunner.layer.pipe(
            Layer.provide(
              Layer.succeed(
                ManagedOutputs,
                partialService<ManagedOutputs["Service"]>("ManagedOutputs", {})
              )
            )
          )
        )
      )
      return {
        before,
        stopped: stopped.runIds,
        after: yield* runGoogleAccounts(sql, "turn-ended", "calendar"),
        script: yield* sql`SELECT status FROM code_mode_scripts`,
        card: yield* sql`SELECT status FROM deferred_tool_calls`,
        fenced: yield* fencedRuns(sql)
      }
    })
  )
  expect(state).toEqual({
    before: null,
    stopped: ["turn-ended"],
    after: [],
    script: [{ status: "cancelled" }],
    card: [{ status: "rejected" }],
    fenced: [{ run_id: "turn-ended" }]
  })
})

it("turning an Automation off fences its ended Run that still runs a script, so its scripts stop", async () => {
  const state = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seedChat(sql)
      yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
          ended_at, metadata_json, assistant_message_id)
        VALUES ('automation-run', 'session-1', 'completed', ${AT}, ${ENDED}, ${ENDED},
          json_object('run_policy', json_object(
            'budget_id', 'budget-1',
            'automation_id', 'auto-1',
            'execution', json_object('mode', 'inline', 'observe', json('false')),
            'capabilities', json_array('all'),
            'auto_approve', json('false'),
            'google_accounts', NULL,
            'space', NULL)),
          'assistant-automation-run')`
      yield* seedScript(sql, "automation-run")
      const before = yield* runGoogleAccounts(sql, "automation-run", "calendar")
      yield* inUnitOfWork(
        revokeAutomationWork({
          sql,
          sessionEvents: yield* SessionLifecycleEvents,
          automationId: "auto-1"
        })
      )
      return {
        before,
        after: yield* runGoogleAccounts(sql, "automation-run", "calendar"),
        fenced: yield* fencedRuns(sql)
      }
    })
  )
  expect(state).toEqual({ before: null, after: [], fenced: [{ run_id: "automation-run" }] })
})

it("a chat's Stop cancels the active turn and also ends what its earlier turns left running", async () => {
  const asked: Array<unknown> = []
  const result = await Effect.runPromise(
    stopRun(
      {
        store: {
          stopEndedWork: (input) =>
            Effect.sync(() => {
              asked.push(input)
              return { runIds: ["turn-1"], descendantRunIds: [] }
            })
        },
        cancelAgent: () => Effect.void
      },
      { sessionId: "session-1" },
      Effect.succeed({ runId: "turn-2" })
    )
  )
  expect({ result, asked }).toEqual({
    result: { runId: "turn-2" },
    asked: [{ sessionId: "session-1" }]
  })
})

it("a script whose Run was fenced is never resumed at boot; it is left for the fence to cancel", async () => {
  const state = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seedChat(sql)
      yield* seedRun(sql, { id: "turn-live", status: "completed" })
      yield* seedScript(sql, "turn-live")
      yield* seedRun(sql, { id: "turn-stopped", status: "running" })
      yield* seedScript(sql, "turn-stopped")
      yield* inUnitOfWork(
        fenceRunCancellation({
          sql,
          sessionEvents: yield* SessionLifecycleEvents,
          runId: "turn-stopped",
          now: ENDED
        })
      )
      const scripts = yield* ScriptStore
      return {
        resumed: (yield* scripts.running()).map((record) => record.originRunId),
        fenced: (yield* scripts.runningOfFencedRuns()).map((record) => record.originRunId)
      }
    })
  )
  expect(state).toEqual({ resumed: ["turn-live"], fenced: ["turn-stopped"] })
})

it("a follow-up that finishes after Stop closed its approved card still records its result", async () => {
  const state = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seedChat(sql)
      yield* seedRun(sql, { id: "turn-ended", status: "completed" })
      yield* seedApprovedCard(sql, "turn-ended")
      yield* (yield* ChatWriteStore).stopEndedWork({ runId: "turn-ended" })
      const closed = yield* sql`SELECT status FROM deferred_tool_calls`
      yield* (yield* DeferredToolCalls).recordRun({
        runId: "turn-ended",
        toolCallId: "card",
        result: { content: "Created Calendar event", preview: "Created", is_error: false }
      })
      return {
        closed,
        recorded: yield* sql`SELECT status, json_extract(result_json, '$.content') AS content
          FROM deferred_tool_calls`
      }
    })
  )
  expect(state).toEqual({
    closed: [{ status: "rejected" }],
    recorded: [{ status: "ran", content: "Created Calendar event" }]
  })
})
