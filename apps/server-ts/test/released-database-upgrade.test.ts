import { ROLE } from "@arden-hq/std/message-vocabulary"
import { sha256Hex } from "@arden-hq/std/hash"
import { Effect, Layer } from "effect"
import { readFile, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { gunzipSync } from "node:zlib"
import { assert, expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { CHAT_WRITE_START, ChatWriteStore } from "../src/persistence/chat/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { LATEST_SCHEMA_VERSION } from "../src/persistence/migrations/index.js"
import { LimitSettingsStore } from "../src/persistence/settings/store.js"
import { authoredText } from "../src/persistence/transcript/content.js"
import { TranscriptQueries } from "../src/persistence/transcript/queries.js"
import { claimAll } from "./fixtures/job-runs.js"
import { sqlitePersistenceLayer, withTempDatabaseFile } from "./fixtures/temp-database.js"

const sessionId = "released-chat"
const createdAt = "2026-11-18T09:00:00.000Z"
const activeMessages = [
  {
    message_id: "first-question",
    role: ROLE.user,
    content: "Where did we stop?",
    created_at: createdAt
  },
  {
    message_id: "first-answer",
    role: ROLE.assistant,
    content: "At the north trailhead.",
    created_at: createdAt
  }
]
const pastMessages = [
  {
    message_id: "older-message",
    role: ROLE.user,
    content: "The south trail is closed.",
    created_at: "2026-11-17T09:00:00.000Z"
  },
  ...activeMessages
]

const followup = {
  message_id: "followup",
  client_id: "followup",
  role: ROLE.user,
  content: "Continue from there.",
  created_at: "2026-11-19T09:00:00.000Z"
}

const request = {
  sessionId,
  clientId: followup.client_id,
  requestHash: "resume-the-released-chat",
  assistantMessageId: "followup-answer",
  message: followup
}

const expectedLimits = {
  ardenLimit: { kind: "at", percent: 82 },
  backgroundLimit: { kind: "unlimited" },
  keepGoing: { kind: "off" },
  automationLimits: {}
}

const withReleasedDatabase = (use: (filename: string) => Promise<void>) =>
  withTempDatabaseFile(async (filename) => {
    const fixture = new URL("./fixtures/engine-v0.3.0.sqlite.gz", import.meta.url)
    await writeFile(filename, gunzipSync(await readFile(fixture)))
    await use(filename)
  })

const seedBeforeUpgrade = (filename: string): void => {
  const database = new DatabaseSync(filename)
  try {
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 173 })
    database
      .prepare(`INSERT INTO sessions
      (session_id, public_ref, name, started_at, last_activity, active_message_count,
        visible_message_count, messages)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        sessionId,
        sessionId,
        "Weekend hike",
        createdAt,
        createdAt,
        activeMessages.length,
        pastMessages.length,
        JSON.stringify(activeMessages)
      )
    const storeMessage = database.prepare(`INSERT INTO session_messages
      (session_id, message_id, seq, role, message_json, created_at, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const [sequence, message] of pastMessages.entries()) {
      storeMessage.run(
        sessionId,
        message.message_id,
        sequence,
        message.role,
        JSON.stringify(message),
        message.created_at,
        message.content
      )
    }
    database
      .prepare(`INSERT INTO monitor_state (namespace, state, updated_at)
      VALUES ('limit_settings', ?, ?)`)
      .run(
        JSON.stringify({
          ardenLimitPercent: 82,
          backgroundLimitPercent: null,
          keepGoingUntil: null,
          automationLimits: {}
        }),
        createdAt
      )
  } finally {
    database.close()
  }
}

const readMessages = Effect.gen(function* () {
  const transcript = yield* TranscriptQueries
  const page = yield* transcript.page({ _tag: "Latest", sessionId, limit: 10 })
  return page.records.map(({ envelope }) => envelope)
})

it("upgrades a released chat and limit settings, then accepts a follow-up exactly once across reopen", async () => {
  await withReleasedDatabase(async (filename) => {
    seedBeforeUpgrade(filename)
    const layer = sqlitePersistenceLayer({ dataDir: null, filename }).pipe(
      Layer.provide(PersistenceWriteQueue.layer)
    )
    const firstOpen = await Effect.runPromise(
      Effect.gen(function* () {
        const limits = yield* LimitSettingsStore
        const chat = yield* ChatWriteStore
        expect(yield* readMessages).toEqual(pastMessages)
        expect(yield* limits.settings()).toEqual(expectedLimits)
        const receipt = yield* chat.start(request)
        return { receipt, messages: yield* readMessages }
      }).pipe(Effect.provide(layer))
    )
    assert(firstOpen.receipt._tag === CHAT_WRITE_START.started)
    expect(firstOpen.receipt.activeMessages.map(({ message_id }) => message_id)).toEqual([
      ...activeMessages.map(({ message_id }) => message_id),
      followup.message_id
    ])
    const { content, ...followupIdentity } = followup
    expect(firstOpen.messages).toEqual([...pastMessages, expect.objectContaining(followupIdentity)])
    expect(authoredText(firstOpen.messages.at(-1)?.content)).toBe(content)

    await Effect.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatWriteStore
        const limits = yield* LimitSettingsStore
        const replay = yield* chat.start(request)
        expect(replay._tag).toBe(CHAT_WRITE_START.existing)
        expect(replay.runId).toBe(firstOpen.receipt.runId)
        expect(yield* readMessages).toEqual(firstOpen.messages)
        expect(yield* limits.settings()).toEqual(expectedLimits)
      }).pipe(Effect.provide(layer))
    )

    const database = new DatabaseSync(filename, { readOnly: true })
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: LATEST_SCHEMA_VERSION
      })
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    } finally {
      database.close()
    }
  })
})

it("keeps a released Automation's schedule and mail rule and claims its saved occurrence", async () => {
  await withReleasedDatabase(async (filename) => {
    const automationId = AutomationId.make("automation:4774be61-56a7-42e7-8b68-eb2be8a93dd7")
    const channelId = "c6e40343-9c28-41a3-bae0-8d040fcf877d"
    const name = "Review trail permits"
    const prompt = "Keep the group updated about trail permits."
    const sentence = "Run only for trail permit notices."
    const scheduledFor = "2026-11-18T09:00:00.000Z"
    const triggers = [
      { id: "t1", type: "time", every: "30m", days: "mon,wed", start: "09:00", end: "17:00" },
      { id: "t2", type: "event", event_type: "email.received", run_only_if: sentence }
    ]
    const instruction = JSON.stringify({
      prompt,
      model: null,
      context_mode: "continue",
      triggers,
      thread_id: channelId,
      cooldown_minutes: null
    })
    const database = new DatabaseSync(filename)
    try {
      database
        .prepare(`INSERT INTO sessions
        (session_id, public_ref, name, started_at, last_activity, session_type, origin_automation_id)
        VALUES (?, ?, ?, ?, ?, 'channel', ?)`)
        .run(channelId, "trail-permits-chat", name, createdAt, createdAt, automationId)
      database
        .prepare(`INSERT INTO automation_instruction_revisions
        (revision_id, task_id, instruction_json, instruction_hash, prompt_author, written_at)
        VALUES (1, ?, ?, ?, 'owner', ?)`)
        .run(automationId, instruction, sha256Hex(instruction), createdAt)
      database
        .prepare(`INSERT INTO scheduled_tasks
        (task_id, automation_ref, name, prompt, triggers, created_at, next_run_at, thread_id,
          trigger_last_id, prompt_author, instruction_revision_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, 'owner', 1)`)
        .run(
          automationId,
          "trail-permits",
          name,
          prompt,
          JSON.stringify(triggers),
          createdAt,
          scheduledFor,
          channelId
        )
    } finally {
      database.close()
    }

    const layer = sqlitePersistenceLayer({ dataDir: null, filename }).pipe(
      Layer.provide(PersistenceWriteQueue.layer)
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* AutomationCatalog
        const automation = yield* catalog.get(automationId)
        expect(automation).toMatchObject({
          name,
          prompt,
          enabled: true,
          next_run: { kind: "scheduled", at: scheduledFor }
        })
        expect(automation?.triggers).toEqual([
          {
            id: "t1",
            type: "time",
            schedule: {
              kind: "interval",
              every: "30m",
              days: { kind: "days", days: "mon,wed" },
              window: { kind: "between", start: "09:00", end: "17:00" }
            }
          },
          {
            id: "t2",
            type: "event",
            event_type: "email.received",
            run_only_if: { kind: "sentence", sentence },
            condition: { kind: "none" }
          }
        ])
        expect(yield* catalog.instructionRevision(1)).toMatchObject({
          automationId,
          prompt,
          author: "owner"
        })
        const leases = yield* claimAll("upgraded-automation")
        expect(
          leases.map(({ payload }) => ({
            automationId: payload.automationId,
            occurrence: payload.occurrence,
            at: payload.scheduledFor,
            sessionId: payload.sessionId
          }))
        ).toEqual([
          { automationId, occurrence: "scheduled", at: scheduledFor, sessionId: channelId }
        ])
      }).pipe(Effect.provide(layer))
    )
  })
})
