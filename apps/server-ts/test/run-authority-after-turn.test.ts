import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ManagedOutputs } from "../src/artifacts/managed-output/managed-output.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
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

type Scenario = {
  readonly name: string
  readonly seed: (sql: SqlClient.SqlClient) => Effect.Effect<void, unknown>
  readonly expected: { readonly liveness: string; readonly taskChange: string }
}

const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "a Run parked for approval still has its turn",
    seed: (sql) => seedRun(sql, { id: "run", status: "pending" }).pipe(Effect.asVoid),
    expected: { liveness: "turn", taskChange: "allowed" }
  },
  {
    name: "a script started by a completed turn keeps the Run in the background",
    seed: (sql) =>
      Effect.gen(function* () {
        yield* seedRun(sql, { id: "run", status: "completed" })
        yield* seedScript(sql, "run")
      }),
    expected: { liveness: "background", taskChange: "allowed" }
  },
  {
    name: "a script of a Run interrupted by a restart keeps the Run in the background",
    seed: (sql) =>
      Effect.gen(function* () {
        yield* seedRun(sql, { id: "run", status: "interrupted" })
        yield* seedScript(sql, "run")
      }),
    expected: { liveness: "background", taskChange: "allowed" }
  },
  {
    name: "a card awaiting an answer keeps the Run in the background",
    seed: (sql) =>
      Effect.gen(function* () {
        yield* seedRun(sql, { id: "run", status: "completed" })
        yield* seedPendingCard(sql, "run")
      }),
    expected: { liveness: "background", taskChange: "allowed" }
  },
  {
    name: "a completed Run with nothing left has ended",
    seed: (sql) => seedRun(sql, { id: "run", status: "completed" }).pipe(Effect.asVoid),
    expected: { liveness: "ended", taskChange: "refused" }
  },
  {
    name: "a spent budget revokes the Run",
    seed: (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO execution_budgets (budget_id, token_limit, tokens_used)
          VALUES ('budget-spent', 10, 10)`
        yield* seedRun(sql, {
          id: "run",
          status: "completed",
          metadata: { run_policy: { budget_id: "budget-spent" } }
        })
        yield* seedScript(sql, "run")
      }),
    expected: { liveness: "revoked", taskChange: "refused" }
  },
  {
    name: "a closed Task revokes the Run",
    seed: (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner,
            created_at, updated_at)
          VALUES ('task-1', NULL, 'reply', 'Reply', 'done', 'worker', ${AT}, ${AT})`
        yield* seedRun(sql, {
          id: "run",
          status: "completed",
          metadata: { run_context: { task: { item_id: "task-1", generation: 0 } } }
        })
        yield* seedScript(sql, "run")
      }),
    expected: { liveness: "revoked", taskChange: "refused" }
  },
  {
    name: "an archived Space revokes the Run",
    seed: (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at,
            updated_at, archived_at)
          VALUES ('space-1', 'Space', 'space', '{"enabled":false}', ${AT}, ${AT}, ${ENDED})`
        yield* seedRun(sql, {
          id: "run",
          status: "completed",
          metadata: { run_policy: { space: { space_id: "space-1", generation: 0 } } }
        })
        yield* seedScript(sql, "run")
      }),
    expected: { liveness: "revoked", taskChange: "refused" }
  },
  {
    name: "Stop revokes a Run that still runs a script",
    seed: (sql) =>
      Effect.gen(function* () {
        yield* seedRun(sql, { id: "run", status: "completed" })
        yield* seedScript(sql, "run")
        yield* inUnitOfWork(
          fenceRunCancellation({
            sql,
            sessionEvents: yield* SessionLifecycleEvents,
            runId: "run",
            now: ENDED
          })
        )
      }),
    expected: { liveness: "revoked", taskChange: "refused" }
  }
]

it.each(scenarios)("$name", async ({ seed, expected }) => {
  const state = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seedChat(sql)
      yield* seed(sql)
      const taskChange = yield* assertRunTaskAuthority(sql, "run").pipe(
        Effect.as("allowed"),
        Effect.catch(() => Effect.succeed("refused"))
      )
      return { liveness: yield* readRunLiveness(sql, "run"), taskChange }
    })
  )
  expect(state).toEqual(expected)
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
