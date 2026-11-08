import { AutomationTriggerInputSchema } from "@arden-hq/protocol/effect/automations"
import type { AutomationEvent } from "@arden-hq/protocol"
import type { SessionListItem } from "@arden-hq/protocol/sessions"
import { Effect, Layer, Option, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { personalAutomationTriggers } from "../src/automations/schedule.js"
import { triggerFeedRecord } from "../src/automations/trigger-feed.js"
import type { InternalLifecycleEvent } from "../src/persistence/sessions/internal-events.js"
import { SessionReadState } from "../src/persistence/sessions/read-state.js"

const decodeTrigger = Schema.decodeUnknownOption(AutomationTriggerInputSchema)

it("event triggers accept only the registry's event types and each event's own fields", () => {
  expect(Option.isNone(decodeTrigger({ type: "event", event_type: "chat.closed" }))).toBe(true)

  const quiet = (field: string, op: "gte" | "contains") => () =>
    personalAutomationTriggers([
      {
        type: "event",
        event_type: "chat.quiet",
        condition: { kind: "compare", field, op, value: 1 }
      }
    ])
  expect(quiet("chat.your_messages", "gte")().triggers).toHaveLength(1)
  expect(quiet("change.page_count", "gte")).toThrow(
    "Unknown chat.quiet condition field: change.page_count"
  )
  expect(quiet("chat.your_messages", "contains")).toThrow(
    "Operator contains is not valid for chat.your_messages"
  )
})

const snapshotKind = (
  session: Pick<SessionListItem, "session_id" | "session_type" | "origin_automation_id">
) =>
  triggerFeedRecord({
    kind: "record",
    sequence: 7,
    createdAtMs: 0,
    replayed: false,
    event: {
      type: "session_activity",
      session: {
        ...session,
        started_at: "2026-09-28T10:00:00.000Z",
        last_activity: "2026-09-28T10:05:00.000Z",
        name: null,
        message_count: 2,
        run_status: "completed",
        is_active: false
      }
    }
  }).kind

it("idle, count and quiet never hear a chat an Automation owns", () => {
  expect({
    yours: snapshotKind({ session_id: "s1", session_type: "chat", origin_automation_id: null }),
    ownChat: snapshotKind({
      session_id: "s2",
      session_type: "channel",
      origin_automation_id: "automation:4"
    }),
    systemTrunk: snapshotKind({
      session_id: "s3",
      session_type: "channel",
      origin_automation_id: "builtin-chat-summaries"
    }),
    spaceRoom: snapshotKind({
      session_id: "s4",
      session_type: "channel",
      origin_automation_id: "space:d1:review"
    }),
    runCopy: snapshotKind({
      session_id: "s1::f12",
      session_type: "chat",
      origin_automation_id: "automation:4"
    }),
    runChild: snapshotKind({
      session_id: "s4::i13",
      session_type: "chat",
      origin_automation_id: "space:d1:review"
    }),
    subagent: snapshotKind({ session_id: "s5", session_type: "agent", origin_automation_id: null }),
    continuedCopy: snapshotKind({
      session_id: "s1::f9",
      session_type: "chat",
      origin_automation_id: null
    })
  }).toEqual({
    yours: "activity",
    ownChat: "other",
    systemTrunk: "other",
    spaceRoom: "other",
    runCopy: "other",
    runChild: "other",
    subagent: "other",
    continuedCopy: "activity"
  })
})

it("your message in a chat an Automation owns is not personal input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-trigger-own-output-"))
  const filename = join(directory, "arden.db")
  const layer = recoveredSqlitePersistenceLayer({ dataDir: null, filename }).pipe(
    Layer.provide(PersistenceWriteQueue.layer)
  )
  const database = () => new DatabaseSync(filename)
  try {
    const [yours, copy] = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        return [
          (yield* sessions.create({ name: "Yours" })).sessionId,
          (yield* sessions.create({ name: "A run's copy" })).sessionId
        ] as const
      }).pipe(Effect.provide(layer))
    )
    const owned = database()
    owned
      .prepare("UPDATE sessions SET origin_automation_id = 'automation:4' WHERE session_id = ?")
      .run(copy)
    owned.close()
    await Effect.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatWriteStore
        for (const sessionId of [yours, copy]) {
          const started = yield* chat.start({
            sessionId,
            clientId: `${sessionId}-input`,
            requestHash: `${sessionId}-hash`,
            assistantMessageId: `${sessionId}-answer`,
            message: {
              message_id: `${sessionId}-input`,
              client_id: `${sessionId}-input`,
              role: "user",
              content: "Anything new?",
              created_at: new Date().toISOString()
            }
          })
          expect(started._tag).toBe("Started")
        }
      }).pipe(Effect.provide(layer))
    )
    const read = database()
    const committed = read
      .prepare(
        "SELECT json_extract(data_json, '$.chat_session_id') AS session_id FROM journal_records WHERE event_type = 'chat_input_committed'"
      )
      .all()
    read.close()
    expect(committed).toEqual([{ session_id: yours }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("a completed run in your chat counts once, however often the chat changes after it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-trigger-run-settled-"))
  const filename = join(directory, "arden.db")
  const layer = recoveredSqlitePersistenceLayer({ dataDir: null, filename }).pipe(
    Layer.provide(PersistenceWriteQueue.layer)
  )
  const at = "2026-10-12T09:00:00.000Z"
  try {
    const sessionId = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const chat = yield* ChatWriteStore
        const readState = yield* SessionReadState
        const { sessionId } = yield* sessions.create({ name: "Yours" })
        const turn = (id: string) =>
          chat
            .start({
              sessionId,
              clientId: id,
              requestHash: id,
              assistantMessageId: `answer-${id}`,
              message: { message_id: id, client_id: id, role: "user", content: id, created_at: at }
            })
            .pipe(
              Effect.flatMap((started) =>
                started._tag === "Started" ? Effect.succeed(started) : Effect.die(started._tag)
              )
            )
        const answered = yield* turn("answered")
        yield* chat.finish({
          runId: answered.runId,
          messages: [
            ...answered.activeMessages,
            { message_id: "answer-answered", role: "assistant", content: "Done", created_at: at }
          ]
        })
        yield* readState.mark(sessionId)
        yield* readState.mark(sessionId)
        const failed = yield* turn("failed")
        yield* chat.fail({ runId: failed.runId, code: "runner_error", message: "Fixture failure" })
        return sessionId
      }).pipe(Effect.provide(layer))
    )
    const database = new DatabaseSync(filename)
    const events = database
      .prepare(
        "SELECT sequence, data_json FROM journal_records WHERE stream_id = 'automation:events' ORDER BY sequence"
      )
      .all()
      .map((row) => ({
        sequence: Number(row["sequence"]),
        event: JSON.parse(String(row["data_json"])) as AutomationEvent | InternalLifecycleEvent
      }))
    database.close()
    expect(events.flatMap(({ event }) => (event.type === "run_settled" ? [event] : []))).toEqual([
      {
        type: "run_settled",
        run_id: expect.any(String),
        session_id: sessionId,
        status: "completed",
        final_message_id: "answer-answered",
        personal: true,
        produced_by: null,
        chain_depth: 0
      },
      {
        type: "run_settled",
        run_id: expect.any(String),
        session_id: sessionId,
        status: "error",
        final_message_id: "answer-failed",
        personal: true,
        produced_by: null,
        chain_depth: 0
      }
    ])
    expect(
      events
        .map(({ sequence, event }) =>
          triggerFeedRecord({ kind: "record", sequence, createdAtMs: 0, replayed: false, event })
        )
        .flatMap((record) => (record.kind === "run_completed" ? [record.sessionId] : []))
    ).toEqual([sessionId])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
