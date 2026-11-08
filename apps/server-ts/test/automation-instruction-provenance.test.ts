import { Effect, Result } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { automationInstructionBackfill } from "../src/persistence/sqlite/automation-instruction-backfill.js"
import { matchesInstructionReceipt } from "../src/persistence/sqlite/automation-instruction-provenance.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-10-15T20:06:01.931Z"

it("a write receipt for the same prompt in a different destination grants no provenance", () => {
  const receipt = {
    is_error: false,
    data: {
      automation_ref: "monitor~ref",
      name: "Monitor",
      prompt: "Check.",
      model: null,
      history: "fresh",
      triggers: [],
      cooldown_minutes: null,
      chat: "own",
      chat_ref: null
    },
    host: { mutation_receipt: { outcome: "applied" } }
  }
  const input = {
    result: receipt,
    args: { name: "Monitor", prompt: "Check." },
    toolName: "automation_create",
    automationRef: "monitor~ref",
    instruction: {
      name: "Monitor",
      prompt: "Check.",
      model: null,
      context_mode: "fresh",
      triggers: "[]",
      thread_id: "chat-id",
      cooldown_minutes: null
    }
  }
  expect(matchesInstructionReceipt({ ...input, destination: { kind: "own" } })).toBe(true)
  expect(
    matchesInstructionReceipt({
      ...input,
      destination: { kind: "yours", publicRef: "another-chat~ref" }
    })
  ).toBe(false)
})

it("captures only the latest matching successful write while malformed legacy rows advance the backfill", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const tools = yield* ToolExecutionStore
      const automation = yield* catalog.create(
        {
          name: "Failure logger",
          prompt: "Record failures every morning.",
          history: "fresh",
          triggers: [{ type: "time", every: "1d" }],
          idempotency_key: "11111111-1111-4111-8111-111111111111",
          idempotency_scope: "global"
        },
        "agent"
      )
      const malformed = yield* catalog.create(
        {
          name: "Malformed legacy",
          prompt: "Review failures.",
          history: "fresh",
          triggers: [{ type: "time", every: "1d" }],
          idempotency_key: "22222222-2222-4222-8222-222222222222",
          idempotency_scope: "global"
        },
        "agent"
      )
      yield* sql`UPDATE scheduled_tasks SET instruction_revision_id = NULL
        WHERE task_id IN (${automation.task_id}, ${malformed.task_id})`
      yield* sql`UPDATE scheduled_tasks SET triggers = 'broken legacy JSON'
        WHERE task_id = ${malformed.task_id}`
      const source = yield* sessions.create({ name: "Source" })
      const started = yield* chat.start({
        sessionId: source.sessionId,
        clientId: "request",
        requestHash: "request",
        assistantMessageId: "assistant",
        message: {
          message_id: "request",
          client_id: "request",
          role: "user",
          content: "Create the failure logger.",
          created_at: AT
        }
      })
      if (started._tag !== "Started") return yield* Effect.die("Run did not start")
      const identity = {
        runId: started.runId,
        sessionId: source.sessionId,
        toolCallId: "create",
        toolName: "automation_create",
        arguments: { name: automation.name, prompt: automation.prompt },
        changesState: true
      }
      yield* tools.begin(identity)
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
      const parsedTriggers: unknown = JSON.parse(row.triggers)
      const result = JSON.stringify({
        is_error: false,
        data: {
          automation_ref: automation.automation_ref,
          name: row.name,
          prompt: row.prompt,
          model: row.model,
          history: row.context_mode,
          triggers: parsedTriggers,
          chat: "own",
          chat_ref: null,
          cooldown_minutes: row.cooldown_minutes
        },
        host: { mutation_receipt: { outcome: "applied" } }
      })
      yield* sql`UPDATE tool_calls SET status = 'completed', result_json = ${result}, ended_at = started_at
        WHERE run_id = ${started.runId} AND tool_call_id = 'create'`
      yield* tools.begin({
        ...identity,
        toolCallId: "malformed",
        toolName: "automation_update",
        arguments: { automation_ref: automation.automation_ref }
      })
      yield* sql`UPDATE tool_calls SET status = 'completed', result_json = '{}', ended_at = started_at
        WHERE run_id = ${started.runId} AND tool_call_id = 'malformed'`
      const scan = yield* automationInstructionBackfill.chunk({ cursor: undefined, limit: 200 })
      const conversion = yield* automationInstructionBackfill.chunk({
        cursor: scan.next,
        limit: 200
      })
      const [saved] = yield* sql<{
        readonly source_run_id: string | null
        readonly source_tool_call_id: string | null
      }>`SELECT revision.source_run_id, revision.source_tool_call_id
        FROM scheduled_tasks AS task JOIN automation_instruction_revisions AS revision
          ON revision.revision_id = task.instruction_revision_id
        WHERE task.task_id = ${automation.task_id}`
      const [bad] = yield* sql<{ readonly instruction_revision_id: number | null }>`
        SELECT instruction_revision_id FROM scheduled_tasks WHERE task_id = ${malformed.task_id}`
      return { scan, conversion, saved, bad }
    })
  )
  expect(outcome.saved).toEqual({
    source_run_id: expect.any(String),
    source_tool_call_id: "create"
  })
  expect(outcome.bad).toEqual({ instruction_revision_id: null })
  expect(outcome.scan.converted).toBe(1)
  expect(outcome.conversion.next).toBeUndefined()
})

it("a same-text owner save preserves an agent prompt's authorship and revision", async () => {
  const revisions = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const automation = yield* catalog.create(
        {
          name: "Monitor",
          prompt: "Check every morning.",
          history: "fresh",
          triggers: [{ type: "time", every: "1d" }],
          idempotency_key: "33333333-3333-4333-8333-333333333333",
          idempotency_scope: "global"
        },
        "agent"
      )
      const pointer = () => sql<{ readonly revision_id: number; readonly author: string | null }>`
        SELECT instruction_revision_id AS revision_id, prompt_author AS author
        FROM scheduled_tasks WHERE task_id = ${automation.task_id}`
      const [before] = yield* pointer()
      yield* catalog.update(
        AutomationId.make(automation.task_id),
        { prompt: "Check every morning." },
        "owner"
      )
      const [same] = yield* pointer()
      yield* catalog.update(
        AutomationId.make(automation.task_id),
        { name: "Daily monitor" },
        "owner"
      )
      const [renamed] = yield* pointer()
      yield* catalog.update(
        AutomationId.make(automation.task_id),
        { prompt: "List every failure." },
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
          role: "user",
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
        {
          name: "Failure logger",
          prompt: "Record failures.",
          history: "fresh",
          triggers: [{ type: "time", every: "1d" }],
          idempotency_key: "44444444-4444-4444-8444-444444444444",
          idempotency_scope: "global"
        },
        "agent",
        { runId: started.runId, toolCallId: "create" }
      )
      const [pointer] = yield* sql<{ readonly instruction_revision_id: number }>`
        SELECT instruction_revision_id FROM scheduled_tasks WHERE task_id = ${automation.task_id}`
      if (pointer === undefined) return yield* Effect.die("Instruction is missing")
      const pending = yield* Effect.result(
        catalog.instructionRevision(pointer.instruction_revision_id)
      )
      yield* sql`UPDATE tool_calls SET status = 'completed', ended_at = started_at,
        result_json = '{"is_error":true}'
        WHERE run_id = ${started.runId} AND tool_call_id = 'create'`
      const failed = yield* Effect.result(
        catalog.instructionRevision(pointer.instruction_revision_id)
      )
      return { pending, failed }
    })
  )
  expect(Result.isFailure(outcomes.pending)).toBe(true)
  expect(Result.isFailure(outcomes.failed)).toBe(true)
})

it("a captured instruction revision cannot be rewritten or deleted", async () => {
  const outcomes = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const automation = yield* catalog.create(
        {
          name: "Monitor",
          prompt: "Check local failures.",
          history: "fresh",
          triggers: [{ type: "time", every: "1d" }],
          idempotency_key: "55555555-5555-4555-8555-555555555555",
          idempotency_scope: "global"
        },
        "owner"
      )
      const [row] = yield* sql<{ readonly instruction_revision_id: number }>`
        SELECT instruction_revision_id FROM scheduled_tasks WHERE task_id = ${automation.task_id}`
      if (row === undefined) return yield* Effect.die("Instruction is missing")
      const rewrite = yield* Effect.result(sql`
        UPDATE automation_instruction_revisions SET prompt_author = 'agent'
        WHERE revision_id = ${row.instruction_revision_id}`)
      const deletion = yield* Effect.result(sql`
        DELETE FROM automation_instruction_revisions
        WHERE revision_id = ${row.instruction_revision_id}`)
      const retained = yield* catalog.instructionRevision(row.instruction_revision_id)
      return { rewrite, deletion, retained }
    })
  )
  expect(Result.isFailure(outcomes.rewrite)).toBe(true)
  expect(Result.isFailure(outcomes.deletion)).toBe(true)
  expect(outcomes.retained?.author).toBe("owner")
})

it("configuration history resolves its original instruction after later edits and toggles", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      const automation = yield* catalog.create(
        {
          name: "History monitor",
          prompt: "First instruction",
          history: "fresh",
          triggers: [{ type: "time", every: "1d" }],
          idempotency_key: "66666666-6666-4666-8666-666666666666",
          idempotency_scope: "global"
        },
        "owner"
      )
      const id = AutomationId.make(automation.task_id)
      const first = yield* catalog.history({ id })
      yield* catalog.update(id, { name: "Renamed monitor", prompt: "Second instruction" }, "owner")
      yield* catalog.toggle(id)
      const current = yield* catalog.history({ id })
      const original = yield* catalog.history({ id, through_version: first.through_version })
      yield* catalog.update(id, { name: "Renamed monitor", prompt: "Second instruction" }, "owner")
      const noop = yield* catalog.history({ id })
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

it("catalog edits do not record instructions for a builtin row", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const automation = yield* catalog.create(
        {
          name: "Builtin monitor",
          prompt: "First instruction",
          history: "fresh",
          triggers: [{ type: "time", every: "1d" }],
          idempotency_key: "77777777-7777-4777-8777-777777777777",
          idempotency_scope: "global"
        },
        "owner"
      )
      yield* sql`UPDATE scheduled_tasks SET builtin = 1 WHERE task_id = ${automation.task_id}`
      const [before] = yield* sql<{ readonly instruction_revision_id: number | null }>`
        SELECT instruction_revision_id FROM scheduled_tasks WHERE task_id = ${automation.task_id}`
      yield* catalog.update(
        AutomationId.make(automation.task_id),
        { prompt: "Second instruction" },
        "owner"
      )
      const [after] = yield* sql<{
        readonly instruction_revision_id: number | null
        readonly count: number
      }>`SELECT task.instruction_revision_id, COUNT(revision.revision_id) AS count
        FROM scheduled_tasks AS task
        LEFT JOIN automation_instruction_revisions AS revision ON revision.task_id = task.task_id
        WHERE task.task_id = ${automation.task_id}`
      return { before, after }
    })
  )
  expect(result.after).toEqual({
    instruction_revision_id: result.before?.instruction_revision_id,
    count: 1
  })
})
