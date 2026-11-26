import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Result, Schema } from "effect"
import { AutomationTriggerSchema } from "@arden-hq/protocol/effect/automations"
import { triggerRecord } from "../src/persistence/automations/trigger-record.js"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { RECORDED_HISTORY_THROUGH } from "../src/persistence/history.js"
import { changes, newAutomation, everyTrigger } from "./fixtures/automation-input.js"

const AT = "2026-10-15T20:06:01.931Z"
const wholeHistory = {
  after_version: 0,
  limit: 50,
  through: RECORDED_HISTORY_THROUGH.head
} as const

it("a same-text owner save preserves an agent prompt's authorship and revision", async () => {
  const revisions = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const automation = yield* catalog.create(
        newAutomation({
          name: "Monitor",
          prompt: "Check every morning.",
          history: "fresh",
          triggers: [everyTrigger("1d")],
          idempotency_key: "33333333-3333-4333-8333-333333333333"
        }),
        "agent"
      )
      const pointer = () => sql<{ readonly revision_id: number; readonly author: string | null }>`
        SELECT instruction_revision_id AS revision_id, prompt_author AS author
        FROM scheduled_tasks WHERE task_id = ${automation.task_id}`
      const [before] = yield* pointer()
      yield* catalog.update(
        AutomationId.make(automation.task_id),
        changes({ kind: "prompt", prompt: "Check every morning." }),
        "owner"
      )
      const [same] = yield* pointer()
      yield* catalog.update(
        AutomationId.make(automation.task_id),
        changes({ kind: "name", name: "Daily monitor" }),
        "owner"
      )
      const [renamed] = yield* pointer()
      yield* catalog.update(
        AutomationId.make(automation.task_id),
        changes({ kind: "prompt", prompt: "List every failure." }),
        "owner"
      )
      const [changed] = yield* pointer()
      return { before, same, renamed, changed }
    })
  )
  expect(revisions.same).toEqual(revisions.before)
  expect(revisions.renamed).toEqual(revisions.before)
  expect(revisions.before?.author).toBe("agent")
  expect(revisions.changed?.author).toBe("owner")
  expect(revisions.changed?.revision_id).not.toBe(revisions.before?.revision_id)
})

it("a saved instruction cannot trust an unfinished or failed source tool call", async () => {
  const outcomes = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const tools = yield* ToolExecutionStore
      const source = yield* sessions.create({ name: "Source" })
      const started = yield* chat.start({
        sessionId: source.sessionId,
        clientId: "request",
        requestHash: "request",
        assistantMessageId: "assistant",
        message: {
          message_id: "request",
          client_id: "request",
          role: ROLE.user,
          content: "Create the failure logger.",
          created_at: AT
        }
      })
      if (started._tag !== "Started") return yield* Effect.die("Run did not start")
      yield* tools.begin({
        runId: started.runId,
        sessionId: source.sessionId,
        toolCallId: "create",
        toolName: "automation_create",
        arguments: { name: "Failure logger", prompt: "Record failures." },
        changesState: true
      })
      const automation = yield* catalog.create(
        newAutomation({
          name: "Failure logger",
          prompt: "Record failures.",
          history: "fresh",
          triggers: [everyTrigger("1d")],
          idempotency_key: "44444444-4444-4444-8444-444444444444"
        }),
        "agent",
        { runId: started.runId, toolCallId: "create" }
      )
      const [pointer] = yield* sql<{ readonly instruction_revision_id: number }>`
        SELECT instruction_revision_id FROM scheduled_tasks WHERE task_id = ${automation.task_id}`
      if (pointer === undefined) return yield* Effect.die("Instruction is missing")
      const trusted = () =>
        Effect.map(
          Effect.result(catalog.instructionRevision(pointer.instruction_revision_id)),
          Result.isSuccess
        )
      const [row] = yield* sql<{
        readonly name: string
        readonly prompt: string
        readonly model: string | null
        readonly context_mode: string
        readonly triggers: string
        readonly cooldown_minutes: number | null
      }>`SELECT name, prompt, model, context_mode, triggers, cooldown_minutes
        FROM scheduled_tasks WHERE task_id = ${automation.task_id}`
      if (row === undefined) return yield* Effect.die("Automation is missing")
      const receipt = (isError: boolean, outcome: string) =>
        JSON.stringify({
          is_error: isError,
          data: {
            automation_ref: automation.automation_ref,
            name: row.name,
            prompt: row.prompt,
            model: row.model,
            history: row.context_mode,
            triggers: Schema.decodeUnknownSync(Schema.Array(AutomationTriggerSchema))(
              JSON.parse(row.triggers)
            ).map(triggerRecord),
            chat: "own",
            chat_ref: null,
            cooldown_minutes: row.cooldown_minutes
          },
          host: { mutation_receipt: { outcome } }
        })
      const settle = (status: string, result: string) =>
        sql`UPDATE tool_calls SET status = ${status}, ended_at = started_at, result_json = ${result}
          WHERE run_id = ${started.runId} AND tool_call_id = 'create'`
      const pending = yield* trusted()
      yield* settle("uncertain", receipt(false, "applied"))
      const unfinishedStatus = yield* trusted()
      yield* settle("completed", receipt(true, "applied"))
      const errored = yield* trusted()
      yield* settle("completed", receipt(false, "skipped"))
      const notApplied = yield* trusted()
      yield* settle("completed", receipt(false, "applied"))
      const finished = yield* trusted()
      return { pending, unfinishedStatus, errored, notApplied, finished }
    })
  )
  expect(outcomes).toEqual({
    pending: false,
    unfinishedStatus: false,
    errored: false,
    notApplied: false,
    finished: true
  })
})

it("configuration history resolves its original instruction after later edits and toggles", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      const automation = yield* catalog.create(
        newAutomation({
          name: "History monitor",
          prompt: "First instruction",
          history: "fresh",
          triggers: [everyTrigger("1d")],
          idempotency_key: "66666666-6666-4666-8666-666666666666"
        }),
        "owner"
      )
      const id = AutomationId.make(automation.task_id)
      const first = yield* catalog.history({ id, ...wholeHistory })
      yield* catalog.update(
        id,
        changes(
          { kind: "name", name: "Renamed monitor" },
          { kind: "prompt", prompt: "Second instruction" }
        ),
        "owner"
      )
      yield* catalog.toggle(id)
      const current = yield* catalog.history({ id, ...wholeHistory })
      const original = yield* catalog.history({
        id,
        after_version: 0,
        limit: 50,
        through: RECORDED_HISTORY_THROUGH.version,
        through_version: first.through_version
      })
      yield* catalog.update(
        id,
        changes(
          { kind: "name", name: "Renamed monitor" },
          { kind: "prompt", prompt: "Second instruction" }
        ),
        "owner"
      )
      const noop = yield* catalog.history({ id, ...wholeHistory })
      return { first, current, original, noop }
    })
  )
  expect(result.original).toEqual(result.first)
  expect(result.first.entries).toHaveLength(1)
  expect(result.first.entries[0]).toMatchObject({
    version: 1,
    kind: "created",
    state: { name: "History monitor", instruction: { prompt: "First instruction" } }
  })
  expect(result.current.entries).toHaveLength(3)
  expect(result.current.entries[1]).toMatchObject({
    version: 2,
    kind: "changed",
    state: { name: "Renamed monitor", instruction: { prompt: "Second instruction" } }
  })
  expect(result.original.entries.at(-1)?.state.instruction).toMatchObject({
    prompt: "First instruction"
  })
  expect(result.current.entries.at(-1)?.state.instruction).toMatchObject({
    prompt: "Second instruction"
  })
  expect(result.current.entries.at(-1)?.state.enabled).toBe(0)
  expect(result.noop).toEqual(result.current)
})
