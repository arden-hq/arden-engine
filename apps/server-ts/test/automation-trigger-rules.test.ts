import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { SessionListItem } from "@arden-hq/protocol/sessions"
import { Effect, Layer, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { triggerFeedRecord } from "../src/automations/trigger-feed.js"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { SessionReadState } from "../src/persistence/sessions/read-state.js"
import { newAutomation, everyTrigger } from "./fixtures/automation-input.js"

const readJournal = <E, R>(layer: Layer.Layer<SessionLifecycleEvents | AutomationTriggers, E, R>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* SessionLifecycleEvents
        const { head } = yield* (yield* AutomationTriggers).triggerCursor()
        const opened = yield* events.open(0)
        if (head === 0) return []
        const deliveries = yield* opened.stream.pipe(
          Stream.takeUntil((delivery) => delivery.kind === "record" && delivery.sequence >= head),
          Stream.runCollect
        )
        return deliveries.flatMap((delivery) => (delivery.kind === "record" ? [delivery] : []))
      })
    ).pipe(Effect.provide(layer))
  )

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
    yours: snapshotKind({
      session_id: "s1",
      session_type: "chat",
      origin_automation_id: null
    }),
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
    subagent: snapshotKind({
      session_id: "s5",
      session_type: "agent",
      origin_automation_id: null
    }),
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

it("only your own message in your own chat is personal input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-trigger-own-output-"))
  const filename = join(directory, "arden.db")
  const layer = recoveredSqlitePersistenceLayer({
    dataDir: null,
    filename
  }).pipe(Layer.provide(PersistenceWriteQueue.layer))
  const database = () => new DatabaseSync(filename)
  let assigned = ""
  try {
    const [yours, copy, destination] = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        return [
          (yield* sessions.create({ name: "Yours" })).sessionId,
          (yield* sessions.create({ name: "A run's copy" })).sessionId,
          (yield* sessions.create({ name: "Destination" })).sessionId
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
              role: ROLE.user,
              content: "Anything new?",
              created_at: new Date().toISOString()
            }
          })
          expect(started._tag).toBe("Started")
        }
        const catalog = yield* AutomationCatalog
        const queue = yield* AutomationQueue
        const automation = yield* catalog.create(
          newAutomation({
            history: "chat",
            name: "Digest",
            prompt: "Review",
            triggers: [everyTrigger("1h")],
            chat: { kind: "yours", session_id: destination },
            idempotency_key: "5d0c2f7e-1a63-4b8e-9d4a-6c3e7f8a9b01"
          }),
          "owner"
        )
        yield* queue.requestRun(AutomationId.make(automation.task_id))
        const [lease] = yield* Effect.promise(async () =>
          queue.jobs.claim({
            workerId: "digest",
            now: Date.now(),
            limit: 1,
            leaseDurationMs: 30_000
          })
        )
        if (lease === undefined || lease.payload.sessionId === null)
          return yield* Effect.die("Expected a lease with a chat")
        assigned = lease.payload.sessionId
        const assignment = yield* chat.start({
          sessionId: assigned,
          clientId: "assigned-input",
          requestHash: "assigned-hash",
          assistantMessageId: "assigned-answer",
          automationLease: { id: lease.id, token: lease.token },
          automation: {
            automationId: AutomationId.make(automation.task_id),
            name: automation.name,
            attemptId: lease.payload.automationRunId
          },
          automationContextMode: "continue",
          automationPrompt: "Review",
          message: {
            message_id: "assigned-input",
            client_id: "assigned-input",
            role: ROLE.interaction,
            kind: "assignment",
            from: {
              source: "automation",
              id: automation.task_id,
              name: automation.name
            },
            content: "Review",
            created_at: new Date().toISOString(),
            automation: {
              context_mode: "continue",
              task_id: automation.task_id,
              name: automation.name,
              prompt: "Review"
            }
          }
        })
        expect(assignment._tag).toBe("Started")
      }).pipe(Effect.provide(layer))
    )
    const committed = (await readJournal(layer)).flatMap(({ event }) =>
      event.type === "chat_input_committed" ? [{ session_id: event.chat_session_id }] : []
    )
    expect(committed).toEqual([{ session_id: yours }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("a completed run in your chat counts once, however often the chat changes after it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-trigger-run-settled-"))
  const filename = join(directory, "arden.db")
  const layer = recoveredSqlitePersistenceLayer({
    dataDir: null,
    filename
  }).pipe(Layer.provide(PersistenceWriteQueue.layer))
  const at = "2026-10-12T09:00:00.000Z"
  try {
    const [sessionId, copyId] = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        return [
          (yield* sessions.create({ name: "Yours" })).sessionId,
          (yield* sessions.create({ name: "A run's copy" })).sessionId
        ] as const
      }).pipe(Effect.provide(layer))
    )
    const owned = new DatabaseSync(filename)
    owned
      .prepare("UPDATE sessions SET origin_automation_id = 'automation:4' WHERE session_id = ?")
      .run(copyId)
    owned.close()
    await Effect.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatWriteStore
        const readState = yield* SessionReadState
        const turn = (id: string, sessionId: string) =>
          chat
            .start({
              sessionId,
              clientId: id,
              requestHash: id,
              assistantMessageId: `answer-${id}`,
              message: {
                message_id: id,
                client_id: id,
                role: ROLE.user,
                content: id,
                created_at: at
              }
            })
            .pipe(
              Effect.flatMap((started) =>
                started._tag === "Started" ? Effect.succeed(started) : Effect.die(started._tag)
              )
            )
        const answered = yield* turn("answered", sessionId)
        yield* chat.finish({
          runId: answered.runId,
          messages: [
            ...answered.activeMessages,
            {
              message_id: "answer-answered",
              role: ROLE.assistant,
              content: "Done",
              created_at: at
            }
          ]
        })
        yield* readState.mark(sessionId)
        yield* readState.mark(sessionId)
        const failed = yield* turn("failed", sessionId)
        yield* chat.fail({
          runId: failed.runId,
          code: "runner_error",
          message: "Fixture failure"
        })
        const copied = yield* turn("copied", copyId)
        yield* chat.finish({
          runId: copied.runId,
          messages: [
            ...copied.activeMessages,
            {
              message_id: "answer-copied",
              role: ROLE.assistant,
              content: "Done",
              created_at: at
            }
          ]
        })
      }).pipe(Effect.provide(layer))
    )
    const events = (await readJournal(layer)).map(({ sequence, event }) => ({ sequence, event }))
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
      },
      {
        type: "run_settled",
        run_id: expect.any(String),
        session_id: copyId,
        status: "completed",
        final_message_id: "answer-copied",
        personal: false,
        produced_by: null,
        chain_depth: 0
      }
    ])
    expect(
      events
        .map(({ sequence, event }) =>
          triggerFeedRecord({
            kind: "record",
            sequence,
            createdAtMs: 0,
            replayed: false,
            event
          })
        )
        .flatMap((record) => (record.kind === "run_completed" ? [record.sessionId] : []))
    ).toEqual([sessionId])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
