import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import {
  pickChatExcerpts,
  taskExcerpts,
  type ChatExcerpt
} from "../src/automations/handlers/daily-summary.js"
import { DayActivity } from "../src/persistence/automations/day-activity.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const chat = (name: string, owner: number, replies: number): ReadonlyArray<ChatExcerpt> => [
  ...Array.from({ length: owner }, (_, index) => ({
    ref: `${name}-owner-${index}`,
    text: `${name} owner ${index}`,
    owner: true
  })),
  ...Array.from({ length: replies }, (_, index) => ({
    ref: `${name}-reply-${index}`,
    text: `${name} reply ${index}`,
    owner: false
  }))
]

it("the day's chat excerpts come from every chat, the owner's words first and newest first", () => {
  const { picked } = pickChatExcerpts(
    [chat("busy", 40, 40), chat("short", 2, 1), chat("one", 1, 0)],
    {
      excerpts: 6,
      chars: 10_000
    }
  )
  expect(picked.map((excerpt) => excerpt.ref)).toEqual([
    "busy-owner-37",
    "busy-owner-38",
    "busy-owner-39",
    "short-owner-0",
    "short-owner-1",
    "one-owner-0"
  ])
})

it("Arden's replies are read only with the room the owner's words leave", () => {
  const { picked, shortened } = pickChatExcerpts([chat("a", 1, 2), chat("b", 1, 2)], {
    excerpts: 30,
    chars: 40
  })
  expect(picked).toEqual([
    { ref: "a-owner-0", text: "a owner 0" },
    { ref: "a-reply-0", text: "a re" },
    { ref: "a-reply-1", text: "a reply 1" },
    { ref: "b-owner-0", text: "b owner 0" },
    { ref: "b-reply-1", text: "b reply 1" }
  ])
  expect(shortened).toBe(1)
})

it("a day's Tasks and items are read once each, inside the day", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const activity = yield* DayActivity
      const item = (id: string, account: string, at: string) =>
        `INSERT INTO connection_items (item_id, source, account, external_id, thread_key, title,
            sender, received_at, snippet, fetched_at)
          VALUES ('${id}', 'gmail', '${account}', '${id}', 'thread-${id}', 'Interview', 'A <a@x.test>',
            '${at}', 'Tuesday works.', '${at}')`
      const event = (id: number, type: string, at: string) =>
        `INSERT INTO space_task_events (space_id, item_id, operation_index, event_type, summary,
            created_at, state_version)
          VALUES ('sp', 'task-1', ${id}, '${type}', '${type} it', '${at}', ${id})`
      for (const statement of [
        `INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
          VALUES ('sp', 'Work', 'work', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
        `INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner, created_at,
            updated_at)
          VALUES ('task-1', 'sp', 'task-1', 'Prepare the brief', 'done', 'worker',
            '2026-11-04T08:00:00.000Z', '2026-11-04T09:00:00.000Z')`,
        event(1, "created", "2026-11-04T08:00:00.000Z"),
        event(2, "updated", "2026-11-04T08:30:00.000Z"),
        event(3, "done", "2026-11-04T09:00:00.000Z"),
        event(4, "blocked", "2026-11-05T09:00:00.000Z"),
        item("m-1", "first", "2026-11-04T10:00:10.000Z"),
        item("m-2", "second", "2026-11-04T10:00:40.000Z"),
        item("m-3", "first", "2026-11-05T10:00:00.000Z")
      ])
        yield* sql.unsafe(statement)
      const day = yield* activity.read({
        start: "2026-11-04T00:00:00.000Z",
        end: "2026-11-05T00:00:00.000Z"
      })
      expect(day.taskEvents.map((change) => change.type)).toEqual(["created", "done"])
      expect(day.items.map((arrived) => arrived.itemId)).toEqual(["m-1"])
      const lines = taskExcerpts(day.taskEvents).lines
      expect(lines.map((line) => line.ref)).toEqual(["arden:task/task-1"])
      expect(lines[0]?.text).toContain("Prepare the brief")
      expect(lines[0]?.text).toContain("done it")
    })
  )
})
