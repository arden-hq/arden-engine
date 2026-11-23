import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { CliTools } from "../src/cli-tools/service.js"
import { composeTurnContext, type TurnContextServices } from "../src/context/turn-context.js"
import { AnswerBlockStore } from "../src/persistence/answer-blocks/store.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { FocusChoiceStore } from "../src/persistence/focus-choices/store.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { readTaskDirection } from "../src/persistence/sqlite/task-direction.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { SummaryStore } from "../src/persistence/summaries/store.js"
import { TodoStore } from "../src/persistence/todos/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { taskDirectionReceipt } from "../src/persistence/work/task-direction.js"
import { SkillCatalog } from "../src/skills/service.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { partialService } from "./kit.js"

const AT = "2026-11-20T08:00:00.000Z"

const seed = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type)
      VALUES ('session-1', 'chat~1', ${AT}, ${AT}, 'chat')`
    yield* sql`INSERT INTO execution_budgets (budget_id) VALUES ('budget-1')`
    yield* sql`INSERT INTO space_tasks (item_id, stable_key, text, body, status, owner, created_at, updated_at)
      VALUES ('task-bound', 'task-bound', 'Bound goal', 'Bound detail', 'open', 'worker', ${AT}, ${AT})`
    yield* sql`INSERT INTO space_tasks (item_id, stable_key, text, body, status, owner, created_at, updated_at,
        home_session_id, runs_in)
      VALUES ('task-chat', 'task-chat', 'Chat goal', 'Chat detail', 'open', 'worker', ${AT}, ${AT},
        'session-1', 'chat')`
    for (const [itemId, text] of [
      ["task-bound", "BOUND_RULE"],
      ["task-chat", "CHAT_RULE"]
    ] as const)
      yield* sql`INSERT INTO task_contract_lines (item_id, kind, text, source_message_id, created_at)
        VALUES (${itemId}, 'rule', ${text}, 'message-1', ${AT})`
    for (const [itemId, next] of [
      ["task-bound", "BOUND_NEXT"],
      ["task-chat", "CHAT_NEXT"]
    ] as const)
      yield* sql`UPDATE space_tasks SET continuation_context = ${JSON.stringify({
        done: [],
        in_progress: [],
        decided: [],
        rejected: [],
        next: [next],
        added: { done: [], decided: [] },
        written_at: AT,
        run_id: null
      })} WHERE item_id = ${itemId}`
    yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
        metadata_json, assistant_message_id)
      VALUES ('run-task', 'session-1', 'running', ${AT}, ${AT},
        json_object('run_policy', json_object(
          'budget_id', 'budget-1',
          'execution', json_object('mode', 'inline', 'observe', json('false')),
          'capabilities', json_array('all'),
          'auto_approve', json('false'),
          'google_accounts', NULL,
          'space', NULL),
        'run_context', json('{"task":{"item_id":"task-bound","generation":0}}')),
        'assistant-run-task')`
    yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
        metadata_json, assistant_message_id)
      SELECT 'run-plain', session_id, status, started_at, updated_at,
        json_set(metadata_json, '$.run_context', json('{}')), 'assistant-run-plain'
      FROM chat_runs WHERE run_id = 'run-task'`
  })

const composed = (runId: string) =>
  withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      const sessions = yield* SessionQueries
      const services: TurnContextServices = {
        sessions,
        runs: yield* RunQueries,
        skills: partialService<SkillCatalog["Service"]>("SkillCatalog", {
          promptCatalog: () => Effect.succeed(undefined)
        }),
        memory: partialService("Memory", {}),
        todos: yield* TodoStore,
        spaces: yield* SpaceStore,
        summaries: yield* SummaryStore,
        work: yield* WorkStore,
        wiki: partialService("Wiki", {}),
        cliTools: partialService<CliTools["Service"]>("CliTools", {
          known: () => Effect.succeed(undefined)
        }),
        focusChoices: yield* FocusChoiceStore,
        answerBlocks: yield* AnswerBlockStore,
        chat: yield* ChatWriteStore,
        permissions: partialService("ToolApprovalPolicy", {}),
        rules: partialService("PermissionRules", {}),
        dataDir: "/nonexistent"
      }
      const header = yield* sessions.loadHistoryHeader("session-1")
      if (header === null) throw new Error("The chat has no header")
      const context = yield* composeTurnContext(
        services,
        { source: "agent", mode: "work", header },
        {
          sessionId: "session-1",
          runId,
          messages: [],
          signal: new AbortController().signal
        }
      )
      const bound = yield* readTaskDirection(sql, "task-bound")
      if (bound === undefined) throw new Error("The bound Task is gone")
      const section = (key: string) => context.sections.find((candidate) => candidate.key === key)
      const direction = section("Task direction")
      return {
        contract: section("Task contract")?.text ?? "",
        receipt: direction?.kind === "direction" ? direction.receipt : undefined,
        expected: taskDirectionReceipt(bound),
        chatTask: section("Task in this chat")?.text ?? "",
        state: section("Task state record")?.text ?? ""
      }
    })
  )

it("a Task run's contract lines, state record and plan receipt are the run's own Task", async () => {
  const outcome = await composed("run-task")
  expect(outcome.contract).toContain("BOUND_RULE")
  expect(outcome.contract).not.toContain("CHAT_RULE")
  expect(outcome.state).toContain("BOUND_NEXT")
  expect(outcome.state).not.toContain("CHAT_NEXT")
  expect(outcome.receipt?.item_id).toBe("task-bound")
  expect(outcome.receipt).toEqual(outcome.expected)
  expect(outcome.chatTask).toContain("Chat goal")
})

it("a run with no Task of its own is shown the chat's Task, and no plan receipt", async () => {
  const outcome = await composed("run-plain")
  expect(outcome.contract).toContain("CHAT_RULE")
  expect(outcome.contract).not.toContain("BOUND_RULE")
  expect(outcome.state).toContain("CHAT_NEXT")
  expect(outcome.state).not.toContain("BOUND_NEXT")
  expect(outcome.receipt).toBeUndefined()
  expect(outcome.chatTask).toContain("Chat goal")
})
