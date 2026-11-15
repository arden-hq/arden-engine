import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { SummaryStore } from "../src/persistence/summaries/store.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import type { SessionHeaderSnapshot } from "../src/persistence/sessions/model.js"
import { readMutationReceipt } from "../src/persistence/tools/mutation-receipt.js"
import { chatSummaryTools } from "../src/tools/chat-summary.js"
import type { ServerRunContext } from "../src/tools/run-context.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { partialService } from "./kit.js"

const AT = "2026-11-14T09:00:00.000Z"
const REMOVAL_TRIGGER = "chat_positions_cut_at_removal"

const turn = Effect.fn("turn")(function* (sessionId: string, id: string) {
  const chat = yield* ChatWriteStore
  const started = yield* chat.start({
    sessionId,
    clientId: id,
    requestHash: id,
    assistantMessageId: `${id}-answer`,
    message: { message_id: id, client_id: id, role: "user", content: id, created_at: AT }
  })
  if (started._tag !== "Started") throw new Error(`Turn ${id} did not start: ${started._tag}`)
  yield* chat.finish({
    runId: started.runId,
    messages: [
      ...started.activeMessages,
      { message_id: `${id}-answer`, role: "assistant", content: `Noted ${id}`, created_at: AT }
    ]
  })
})

const summary = (sessionId: string, title: string, throughSequence: number) => ({
  sessionId,
  title,
  summary: `About ${title}.`,
  topics: [],
  throughSequence,
  runId: null
})

it("a revert removes the chat summary it cuts into, so no removed turn stays summarized", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const summaries = yield* SummaryStore
      const chat = (yield* sessions.create({})).sessionId
      yield* turn(chat, "first")
      yield* turn(chat, "second")
      yield* turn(chat, "third")
      yield* summaries.setChat(summary(chat, "Three turns", 5))
      yield* sessions.revert({ sessionId: chat, turns: 2 })
      const cut = yield* summaries.chat(chat)
      yield* turn(chat, "again")
      const newer = yield* summaries.setChat(summary(chat, "Two turns", 3))
      const older = yield* summaries.setChat(summary(chat, "One turn", 1))
      const saved = (yield* summaries.chat(chat))?.title
      yield* sessions.revert({ sessionId: chat, turns: 2 })
      return { cut, newer, older, saved, emptied: yield* summaries.chat(chat) }
    })
  )
  expect(outcome).toEqual({
    cut: null,
    newer: true,
    older: false,
    saved: "Two turns",
    emptied: null
  })
})

const NOT_POSITIONS: Readonly<Record<string, string>> = {
  "session_messages.seq": "the message numbers themselves",
  "session_turns.message_start_seq": "rebuilt from the messages by the revert",
  "session_turns.message_end_seq": "rebuilt from the messages by the revert",
  "sessions.context_from_seq": "rewritten by the revert with the active context",
  "sessions.context_head_seq": "rewritten by the revert with the active context",
  "session_context_hidden.seq": "rewritten by the revert with the active context",
  "session_context_stage.from_seq": "a staged conversion restarts when the newest message changes",
  "session_context_stage.head_seq": "a staged conversion restarts when the newest message changes",
  "session_context_stage.newest_seq":
    "a staged conversion restarts when the newest message changes",
  "session_context_stage.last_seq": "a staged conversion restarts when the newest message changes",
  "chat_runs.last_seq": "a position in the run's event journal, not a message number",
  "session_event_checkpoints.checkpoint_seq": "a position in the chat's event journal",
  "chat_compactions.boundary_seq": "a record of a past compaction; read only as whether one exists",
  "automation_count_state.through_sequence": "a position in the session lifecycle stream",
  "space_tasks.seq": "a Task's number within its Space",
  "task_proposals.seq": "an offer's order, not a message number"
}

it("cuts every per-chat message position in the one removal trigger", async () => {
  const found = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      const columns: Array<string> = []
      for (const { name } of tables) {
        const info = yield* sql<{ readonly name: string }>`
          SELECT name FROM pragma_table_info(${name})`
        const names = info.map((column) => column.name)
        if (!names.some((column) => /(^|_)session_id$/u.test(column))) continue
        for (const column of names)
          if (/(^|_)seq($|_)|sequence/u.test(column)) columns.push(`${name}.${column}`)
      }
      const [trigger] = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ${REMOVAL_TRIGGER}`
      const others = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name = 'session_messages' AND name != ${REMOVAL_TRIGGER}`
      return { columns, body: trigger?.sql ?? "", others: others.map((row) => row.sql) }
    })
  )
  const cut = found.columns.filter((column) => !(column in NOT_POSITIONS))
  const uncut = cut.filter((column) => {
    const [table, name] = column.split(".")
    return !(
      new RegExp(`(UPDATE|DELETE FROM) ${table}\\b`, "u").test(found.body) &&
      new RegExp(`\\b${name}\\b`, "u").test(found.body)
    )
  })
  const cutTables = new Set(cut.map((column) => column.split(".")[0] ?? column))
  expect(
    found.others.filter((body) => [...cutTables].some((table) => body.includes(table)))
  ).toEqual([])
  expect(cut.sort()).toEqual([
    "chat_summaries.through_sequence",
    "memory_capture_backlog.from_seq",
    "memory_capture_backlog.through_seq",
    "memory_capture_positions.prepared_cut_seq",
    "memory_capture_positions.read_seq"
  ])
  expect(uncut).toEqual([])
  expect(Object.keys(NOT_POSITIONS).filter((column) => !found.columns.includes(column))).toEqual([])
})

it("tells the run a summary was not saved when the stored one reaches further", async () => {
  const result = async (saved: boolean) => {
    const [tool] = await Effect.runPromise(
      chatSummaryTools.pipe(
        Effect.provideService(
          SessionQueries,
          partialService<SessionQueries["Service"]>("SessionQueries", {
            loadHeaderSnapshot: () =>
              Effect.succeed({
                header: { startedAt: DateTime.makeUnsafe("2026-11-12T09:00:00.000Z") },
                metadata: { fork_of: { source_session_id: "chat", through_sequence: 3 } }
              } as unknown as SessionHeaderSnapshot),
            loadHistoryHeader: () => Effect.succeed(null)
          })
        ),
        Effect.provideService(
          SummaryStore,
          partialService<SummaryStore["Service"]>("SummaryStore", {
            setChat: () => Effect.succeed(saved)
          })
        )
      )
    )
    if (tool === undefined) throw new Error("set_chat_summary is missing")
    const output = await tool.execute(
      { outcome: "summary", title: "Three turns", summary: "What the chat covered." },
      {
        toolCallId: "call-1",
        signal: new AbortController().signal,
        run: { sessionId: "fork", runId: "run-1" } as unknown as ServerRunContext,
        messages: []
      }
    )
    return { content: output.content, outcome: readMutationReceipt(output.host)?.outcome }
  }
  expect(await result(false)).toEqual({
    content: "Not saved: the stored summary of this chat already reaches further.",
    outcome: "no_op"
  })
  expect(await result(true)).toEqual({ content: "Summary saved.", outcome: "applied" })
})
