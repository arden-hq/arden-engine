import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { CommunicationDoor } from "@arden-hq/protocol/chat"
import { noticeTier } from "@arden-hq/protocol/notifications"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { eventsHandler } from "../src/automations/handlers/events.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { PostStore, type PostInput } from "../src/persistence/posts/store.js"
import { ConnectionItemStore } from "../src/persistence/connections/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { loadActiveContext } from "../src/persistence/sqlite/active-context.js"
import { recentNotices } from "../src/persistence/sqlite/notices.js"
import { tellChat } from "../src/persistence/sqlite/owner-update.js"
import { chatRow } from "../src/persistence/sqlite/run-destination.js"
import { postDeliveryId } from "../src/persistence/sqlite/run-post.js"
import { taskDoor } from "../src/persistence/sqlite/ending-arrival.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { appendMessagesInTransaction } from "../src/persistence/sqlite/chat-transcript.js"
import { messageQuote } from "../src/persistence/sqlite/message-quote.js"

const AT = "2026-11-20T00:00:00.000Z"
const automationId = eventsHandler.spec.automationId

const setup = Effect.gen(function* () {
  yield* (yield* AutomationCatalog).seedSystemAutomations([eventsHandler.spec])
  const sql = yield* SqlClient.SqlClient
  const spaces = yield* SpaceStore
  const listed = yield* spaces.list()
  const main = listed.find((space) => space.kind === "main")
  if (main === undefined) return yield* Effect.die("no Main Space")
  const thread = (itemId: string, threadKey: string, account = "me@example.com") =>
    sql`INSERT INTO connection_item_threads (item_id, source, account, thread_key)
      VALUES (${itemId}, 'gmail', ${account}, ${threadKey})`
  const message = (sessionId: string, messageId: string) =>
    sql<{ readonly message_json: string }>`SELECT message_json FROM session_messages
      WHERE session_id = ${sessionId} AND message_id = ${messageId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : JSON.parse(rows[0].message_json)))
    )
  const delivery = (attemptId: number) =>
    sql<{
      readonly status: string
      readonly attempt_count: number
      readonly reason: string | null
    }>`SELECT status, attempt_count, json_extract(payload, '$.withdrawal.reason') AS reason
      FROM automation_deliveries WHERE delivery_id = ${postDeliveryId(attemptId)}`.pipe(
      Effect.map((rows) => rows[0])
    )
  const posts = yield* PostStore
  const drain = Effect.gen(function* () {
    let delivered = 0
    for (const pending of yield* posts.pendingDeliveries())
      if (yield* posts.deliver(pending)) delivered += 1
    return delivered
  })
  const leaseOf = (attemptId: number) =>
    Effect.gen(function* () {
      yield* sql`INSERT OR IGNORE INTO automation_runs (id, task_id, started_at, status, claim_count)
        VALUES (${attemptId}, ${automationId}, ${AT}, 'running', 1)`
      const queued = yield* sql<{ readonly id: number }>`
        SELECT id FROM automation_event_queue
        WHERE json_extract(context, '$.automation_run_id') = ${attemptId}`
      const id =
        queued[0]?.id ??
        (yield* sql<{ readonly id: number }>`INSERT INTO automation_event_queue (task_id, source,
            event_key, context, created_at, claimed_at, lease_expires_at, attempt_count)
          VALUES (${automationId}, 'event', ${`mail-${attemptId}`},
            ${JSON.stringify({ scheduled_for: null, automation_run_id: attemptId })}, ${AT}, ${AT},
            '2999-01-01T00:00:00.000Z', 1)
          RETURNING id`)[0]?.id
      if (id === undefined) return yield* Effect.die("no queue row")
      return { id: String(id), token: `${attemptId}|1` }
    })
  const post = (attemptId: number, fields: Partial<PostInput> = {}) =>
    Effect.gen(function* () {
      return yield* posts.post({
        automationId,
        attemptId,
        lease: yield* leaseOf(attemptId),
        runId: `run-${attemptId}`,
        spaceId: undefined,
        text: `Post ${attemptId}`,
        task: undefined,
        itemIds: [],
        ...fields
      })
    })
  return { sql, spaces, main, thread, message, delivery, posts, post, leaseOf, drain }
})

it("a post lands in its Space chat as an unread assistant message, with a notice and no run", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, spaces, post, drain, message } = yield* setup
      const taxes = yield* spaces.create({ name: "Taxes" })
      const posted = yield* post(1, { spaceId: taxes.space_id, text: "The bank wrote back." })
      expect(yield* message(posted.sessionId, posted.messageId)).toBeUndefined()
      expect(yield* drain).toBe(1)
      const context = yield* loadActiveContext(sql, posted.sessionId)
      expect(context.map((row) => [row.message_id, row.role, row.content])).toEqual([
        [posted.messageId, ROLE.assistant, "The bank wrote back."]
      ])
      const chat = yield* sql<{ readonly has_unread: number; readonly space_id: string }>`
        SELECT has_unread, space_id FROM sessions WHERE session_id = ${posted.sessionId}`
      expect(chat).toEqual([{ has_unread: 1, space_id: taxes.space_id }])
      expect(yield* sql`SELECT 1 FROM chat_runs`).toEqual([])
      const notices = yield* recentNotices(sql, { since: AT, limit: 10 })
      expect(notices).toMatchObject([
        {
          key: posted.messageId,
          record: "entity",
          status: "posted",
          shown: true,
          title: "Taxes",
          text: "The bank wrote back.",
          chatSessionId: posted.sessionId
        }
      ])
      expect(
        noticeTier({ kind: "entity", key: "k", status: "posted", shown: true, unread: true })
      ).toBe("needs_you")
      expect(yield* drain).toBe(0)
    })
  )
})

it("no Space, an unknown Space or an archived Space posts in Main; the same attempt posts once", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, spaces, main, post, drain } = yield* setup
      const gone = yield* spaces.create({ name: "Gone" })
      yield* spaces.archive(gone.space_id)
      const places = [
        yield* post(1),
        yield* post(2, { spaceId: "no-such-space" }),
        yield* post(3, { spaceId: gone.space_id })
      ]
      const mainChat = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM space_conversations WHERE space_id = ${main.space_id}`
      expect(new Set(places.map((place) => place.sessionId))).toEqual(
        new Set(mainChat.map((row) => row.session_id))
      )
      expect(yield* post(1, { spaceId: gone.space_id, text: "Again" })).toEqual(places[0])
      expect((yield* drain) + (yield* drain) + (yield* drain)).toBe(3)
      expect(yield* post(1, { text: "After delivery" })).toEqual(places[0])
      expect(yield* sql`SELECT 1 FROM automation_deliveries`).toHaveLength(3)
    })
  )
})

it("a later event of a thread lands under the first post, in its chat, whatever Space was named", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, spaces, thread, post, drain, message } = yield* setup
      const taxes = yield* spaces.create({ name: "Taxes" })
      const travel = yield* spaces.create({ name: "Travel" })
      yield* thread("mail-1", "t1")
      yield* thread("mail-2", "t1")
      yield* thread("other-account", "t1", "work@example.com")
      const first = yield* post(1, { spaceId: taxes.space_id, itemIds: ["mail-1"] })
      const second = yield* post(2, { spaceId: travel.space_id, itemIds: ["mail-2"] })
      expect(second.sessionId).toBe(first.sessionId)
      expect(
        yield* sql`SELECT 1 FROM space_conversations WHERE space_id = ${travel.space_id}`
      ).toEqual([])
      expect(yield* drain).toBe(1)
      expect(yield* drain).toBe(1)
      expect((yield* message(second.sessionId, second.messageId))?.replyTo).toEqual({
        messageId: first.messageId,
        role: ROLE.assistant,
        content: "Post 1"
      })
      const elsewhere = yield* post(3, { spaceId: travel.space_id, itemIds: ["other-account"] })
      expect(elsewhere.sessionId).not.toBe(first.sessionId)
      yield* drain
      expect((yield* message(elsewhere.sessionId, elsewhere.messageId))?.replyTo).toBeUndefined()
    })
  )
})

it("a thread whose chat was archived maps to the new post", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, spaces, thread, post, drain, message } = yield* setup
      const taxes = yield* spaces.create({ name: "Taxes" })
      yield* thread("mail-1", "t1")
      yield* thread("mail-2", "t1")
      yield* thread("mail-3", "t1")
      const first = yield* post(1, { spaceId: taxes.space_id, itemIds: ["mail-1"] })
      yield* drain
      yield* spaces.archive(taxes.space_id)
      const second = yield* post(2, { itemIds: ["mail-2"] })
      expect(second.sessionId).not.toBe(first.sessionId)
      yield* drain
      expect((yield* message(second.sessionId, second.messageId))?.replyTo).toBeUndefined()
      const third = yield* post(3, { itemIds: ["mail-3"] })
      yield* drain
      expect((yield* message(third.sessionId, third.messageId))?.replyTo).toMatchObject({
        messageId: second.messageId
      })
      expect(yield* sql`SELECT message_id FROM event_threads WHERE thread_key = 't1'`).toEqual([
        { message_id: second.messageId }
      ])
    })
  )
})

it("a post whose earlier message was cleared away is delivered without the quote", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { thread, post, drain, message } = yield* setup
      const sessions = yield* SessionStore
      yield* thread("mail-1", "t1")
      yield* thread("mail-2", "t1")
      const first = yield* post(1, { itemIds: ["mail-1"] })
      const second = yield* post(2, { itemIds: ["mail-2"] })
      expect(yield* drain).toBe(1)
      yield* sessions.clear(first.sessionId)
      expect(yield* drain).toBe(1)
      const delivered = yield* message(second.sessionId, second.messageId)
      expect(delivered).toMatchObject({ role: ROLE.assistant, content: "Post 2" })
      expect(delivered?.replyTo).toBeUndefined()
      const travel = yield* (yield* SpaceStore).create({ name: "Travel" })
      yield* thread("mail-3", "t1")
      const third = yield* post(3, { itemIds: ["mail-3"], spaceId: travel.space_id })
      expect(third.sessionId).toBe(second.sessionId)
      yield* drain
      expect((yield* message(third.sessionId, third.messageId))?.replyTo).toMatchObject({
        messageId: second.messageId
      })
    })
  )
})

it("a post still brings its notice when its Automation was removed while it waited", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, post, drain } = yield* setup
      const posted = yield* post(1)
      yield* sql`DELETE FROM scheduled_tasks WHERE task_id = ${automationId}`
      expect(yield* drain).toBe(1)
      expect(yield* recentNotices(sql, { since: AT, limit: 10 })).toMatchObject([
        { key: posted.messageId, status: "posted" }
      ])
    })
  )
})

it("a post waits while its chat has a turn open, with no failed attempt, and comes with its notice and Task", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, post, drain, delivery, message, thread } = yield* setup
      const chat = yield* ChatWriteStore
      yield* thread("mail-1", "t1")
      const posted = yield* post(1, {
        itemIds: ["mail-1"],
        task: { title: "Pay the bill", brief: "Pay it before Friday." }
      })
      const started = yield* chat.start({
        sessionId: posted.sessionId,
        clientId: "busy",
        requestHash: "busy",
        assistantMessageId: "busy-answer",
        message: {
          message_id: "busy",
          client_id: "busy",
          role: ROLE.user,
          content: "Working",
          created_at: AT
        }
      })
      if (started._tag !== "Started") return yield* Effect.die("chat run did not start")
      expect(yield* drain).toBe(0)
      expect(yield* (yield* PostStore).deliver({ deliveryId: postDeliveryId(1), attempt: 0 })).toBe(
        false
      )
      expect(yield* delivery(1)).toEqual({ status: "pending", attempt_count: 0, reason: null })
      expect(yield* message(posted.sessionId, posted.messageId)).toBeUndefined()
      expect(yield* recentNotices(sql, { since: AT, limit: 10 })).toEqual([])
      expect(yield* sql`SELECT 1 FROM space_tasks`).toEqual([])
      yield* sql`UPDATE chat_runs SET status = 'completed', ended_at = updated_at
        WHERE run_id = ${started.runId}`
      expect(yield* drain).toBe(1)
      expect(yield* recentNotices(sql, { since: AT, limit: 10 })).toHaveLength(1)
      expect(
        yield* sql`SELECT run_ref FROM space_task_events WHERE event_type = 'created'`
      ).toEqual([{ run_ref: "run-1" }])
      const tasks = yield* sql`SELECT text, body, origin_message_id, owner FROM space_tasks`
      expect(tasks).toEqual([
        {
          text: "Pay the bill",
          body: "Pay it before Friday.",
          origin_message_id: posted.messageId,
          owner: "worker"
        }
      ])
    })
  )
})

it("posts with the same Task title in one Space each start a Task; a thread with a Task starts none", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, post, drain, thread } = yield* setup
      yield* thread("mail-1", "t1")
      yield* thread("mail-2", "t2")
      yield* thread("mail-3", "t1")
      const task = { title: "Pay the bill", brief: "Pay it." }
      yield* post(1, { itemIds: ["mail-1"], task })
      yield* post(2, { itemIds: ["mail-2"], task })
      yield* drain
      yield* post(3, { itemIds: ["mail-3"], task })
      yield* drain
      expect(yield* sql`SELECT stable_key FROM space_tasks ORDER BY stable_key`).toEqual([
        { stable_key: "pay-the-bill" },
        { stable_key: "pay-the-bill-2" }
      ])
    })
  )
})

it("an undecodable post and one whose chat was archived are withdrawn, and the work outbox never takes a post", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, spaces, post, drain, delivery } = yield* setup
      const work = yield* WorkStore
      const taxes = yield* spaces.create({ name: "Taxes" })
      yield* post(1)
      yield* post(2, { spaceId: taxes.space_id })
      expect(yield* work.pendingDeliveries()).toEqual([])
      yield* sql`UPDATE automation_deliveries SET payload = json_set(payload, '$.text', 42)
        WHERE delivery_id = ${postDeliveryId(1)}`
      yield* spaces.archive(taxes.space_id)
      expect(yield* drain).toBe(0)
      expect(yield* delivery(1)).toEqual({
        status: "discarded",
        attempt_count: 0,
        reason: "undecodable"
      })
      expect(yield* delivery(2)).toEqual({
        status: "discarded",
        attempt_count: 0,
        reason: "destination_archived"
      })
      expect(yield* (yield* PostStore).pendingDeliveries()).toEqual([])
    })
  )
})

it("a Task update quotes the post that started it, only in that post's chat", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, post, drain } = yield* setup
      const work = yield* WorkStore
      const sessions = yield* SessionStore
      const posted = yield* post(1, { text: "Bill due", task: { title: "Pay", brief: "Pay it." } })
      yield* drain
      const task = (yield* sql<{ readonly item_id: string }>`SELECT item_id FROM space_tasks`)[0]
      if (task === undefined) return yield* Effect.die("no Task")
      const other = yield* sessions.create({ name: "Other" })
      const tell = (
        sessionId: string,
        key: string,
        door: CommunicationDoor = taskDoor(task.item_id, "Pay")
      ) =>
        Effect.gen(function* () {
          const destination = yield* chatRow(sql, sessionId)
          if (destination === undefined) return yield* Effect.die("no chat")
          yield* tellChat({
            sql,
            weight: "news",
            occurrenceKey: key,
            source: { kind: "entity", key },
            sourceRunId: "run-1",
            sourceSessionRef: destination.public_ref,
            destination,
            line: "Paid.",
            door,
            event: "finished",
            occurredAt: AT
          })
        })
      yield* appendMessagesInTransaction(
        sql,
        other.sessionId,
        [{ message_id: posted.messageId, role: ROLE.user, content: "Same id", created_at: AT }],
        AT,
        "post",
        posted.messageId
      )
      yield* tell(posted.sessionId, "in-post-chat")
      yield* tell(posted.sessionId, "artifact-in-post-chat", {
        kind: "artifact",
        label: "receipt.pdf",
        item_id: task.item_id,
        attachment_id: 1,
        href: `arden:task/${encodeURIComponent(task.item_id)}`
      })
      yield* tell(other.sessionId, "elsewhere")
      const pending = yield* work.pendingDeliveries()
      const quote = { messageId: posted.messageId, role: ROLE.assistant, content: "Bill due" }
      expect(
        pending
          .flatMap((delivery) =>
            delivery.payload.kind === "update"
              ? [[delivery.payload.update.key, delivery.payload.replyTo]]
              : []
          )
          .toSorted((left, right) => String(left[0]).localeCompare(String(right[0])))
      ).toEqual([
        ["artifact-in-post-chat", quote],
        ["elsewhere", undefined],
        ["in-post-chat", quote]
      ])
    })
  )
})

it("a quote keeps only the quoted message's text, never its image data", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql } = yield* setup
      const sessions = yield* SessionStore
      const chat = yield* sessions.create({ name: "Photo" })
      yield* appendMessagesInTransaction(
        sql,
        chat.sessionId,
        [
          {
            message_id: "photo",
            role: ROLE.user,
            content: [
              { type: "text", text: "Pay this bill" },
              { type: "image", media_type: "image/png", data: "A".repeat(200_000) }
            ],
            created_at: AT
          },
          {
            message_id: "picture-only",
            role: ROLE.user,
            content: [{ type: "image", media_type: "image/png", data: "AAAA" }],
            created_at: AT
          }
        ],
        AT,
        "post",
        "photo"
      )
      expect(yield* messageQuote(sql, { sessionId: chat.sessionId, messageId: "photo" })).toEqual({
        messageId: "photo",
        role: ROLE.user,
        content: "Pay this bill"
      })
      expect(
        yield* messageQuote(sql, { sessionId: chat.sessionId, messageId: "picture-only" })
      ).toBeUndefined()
    })
  )
})

it("a Task title on two lines is refused before the post is queued", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, post } = yield* setup
      const refused = yield* post(1, { task: { title: "Pay\nthe bill", brief: "Pay it." } }).pipe(
        Effect.flip
      )
      expect(refused).toMatchObject({ reason: "invalid" })
      expect(yield* sql`SELECT 1 FROM automation_deliveries`).toEqual([])
    })
  )
})

it("two replies queued under a root that was cleared: the first stands alone, the second quotes it", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { thread, post, drain, message } = yield* setup
      const sessions = yield* SessionStore
      yield* thread("mail-1", "t1")
      yield* thread("mail-2", "t1")
      yield* thread("mail-3", "t1")
      const first = yield* post(1, { itemIds: ["mail-1"] })
      expect(yield* drain).toBe(1)
      const second = yield* post(2, { itemIds: ["mail-2"] })
      const third = yield* post(3, { itemIds: ["mail-3"] })
      yield* sessions.clear(first.sessionId)
      expect((yield* drain) + (yield* drain)).toBe(2)
      expect((yield* message(second.sessionId, second.messageId))?.replyTo).toBeUndefined()
      expect((yield* message(third.sessionId, third.messageId))?.replyTo).toEqual({
        messageId: second.messageId,
        role: ROLE.assistant,
        content: "Post 2"
      })
    })
  )
})

it("replies queued in the same millisecond deliver in the order they were queued", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, thread, post, drain, message } = yield* setup
      const sessions = yield* SessionStore
      const later = [3, 4, 5, 6, 7, 8, 9, 10].find(
        (attempt) => postDeliveryId(attempt) < postDeliveryId(2)
      )
      if (later === undefined) return yield* Effect.die("no attempt hashes below attempt 2")
      yield* thread("mail-1", "t1")
      yield* thread("mail-2", "t1")
      yield* thread("mail-3", "t1")
      const root = yield* post(1, { itemIds: ["mail-1"] })
      yield* drain
      const earlier = yield* post(2, { itemIds: ["mail-2"] })
      const after = yield* post(later, { itemIds: ["mail-3"] })
      yield* sql`UPDATE automation_deliveries SET created_at = ${AT}
        WHERE delivery_id IN (${postDeliveryId(2)}, ${postDeliveryId(later)})`
      yield* sessions.clear(root.sessionId)
      expect((yield* drain) + (yield* drain)).toBe(2)
      expect((yield* message(earlier.sessionId, earlier.messageId))?.replyTo).toBeUndefined()
      expect((yield* message(after.sessionId, after.messageId))?.replyTo).toMatchObject({
        messageId: earlier.messageId
      })
    })
  )
})

it("a reply waits for the reply queued before it, even while that one is retried later", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { thread, post, drain, delivery, posts } = yield* setup
      yield* thread("mail-1", "t1")
      yield* thread("mail-2", "t1")
      yield* thread("mail-3", "t1")
      yield* post(1, { itemIds: ["mail-1"] })
      yield* drain
      yield* post(2, { itemIds: ["mail-2"] })
      yield* post(3, { itemIds: ["mail-3"] })
      yield* posts.defer({ deliveryId: postDeliveryId(2), attempt: 0 }, "failed once")
      expect(yield* drain).toBe(0)
      expect(yield* delivery(3)).toMatchObject({ status: "pending" })
    })
  )
})

it("posts to one chat go out in queue order; a post to another chat is never held by them", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { spaces, thread, post, drain, delivery, posts } = yield* setup
      const taxes = yield* spaces.create({ name: "Taxes" })
      yield* thread("mail-1", "t1")
      yield* thread("mail-2", "t2")
      yield* thread("mail-3", "t1")
      yield* thread("mail-4", "t2")
      yield* post(1, { itemIds: ["mail-1"] })
      yield* post(2, { itemIds: ["mail-2"] })
      yield* posts.defer({ deliveryId: postDeliveryId(1), attempt: 0 }, "failed once")
      const both = yield* post(3, { itemIds: ["mail-3", "mail-4"] })
      yield* post(4, { spaceId: taxes.space_id })
      expect(yield* drain).toBe(1)
      expect(yield* delivery(4)).toMatchObject({ status: "delivered" })
      expect([
        (yield* delivery(2))?.status,
        (yield* delivery(3))?.status,
        both.sessionId === (yield* post(1)).sessionId
      ]).toEqual(["pending", "pending", true])
    })
  )
})

it("a thread whose pending post's Space was archived takes the next post to Main", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, spaces, main, thread, post } = yield* setup
      const taxes = yield* spaces.create({ name: "Taxes" })
      yield* thread("mail-1", "t1")
      yield* thread("mail-2", "t1")
      yield* post(1, { itemIds: ["mail-1"], spaceId: taxes.space_id })
      yield* spaces.archive(taxes.space_id)
      const next = yield* post(2, { itemIds: ["mail-2"] })
      expect(
        yield* sql`SELECT space_id FROM sessions WHERE session_id = ${next.sessionId}`
      ).toEqual([{ space_id: main.space_id }])
    })
  )
})

it("a post whose Task the Task store would refuse is refused before it is queued", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, post } = yield* setup
      const refused = yield* post(1, {
        itemIds: [" "],
        task: { title: "Pay", brief: "Pay it." }
      }).pipe(Effect.flip)
      expect(refused).toMatchObject({ reason: "invalid" })
      expect(yield* sql`SELECT 1 FROM automation_deliveries`).toEqual([])
    })
  )
})

it("a post that keeps failing is set aside and stops holding its chat", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { post, drain, delivery, posts } = yield* setup
      yield* post(1)
      yield* post(2)
      for (let attempt = 0; attempt < 10; attempt += 1)
        yield* posts.defer({ deliveryId: postDeliveryId(1), attempt }, "failed")
      expect(yield* delivery(1)).toEqual({
        status: "discarded",
        attempt_count: 10,
        reason: "undeliverable"
      })
      expect(yield* drain).toBe(1)
      expect(yield* delivery(2)).toMatchObject({ status: "delivered" })
    })
  )
})

it("a run whose lease is no longer current posts nothing", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, post, posts, leaseOf } = yield* setup
      yield* post(1)
      const lease = yield* leaseOf(2)
      yield* sql`UPDATE automation_event_queue SET lease_expires_at = ${AT}`
      const refused = yield* posts
        .post({
          automationId,
          attemptId: 2,
          lease,
          runId: "run-2",
          spaceId: undefined,
          text: "Late",
          task: undefined,
          itemIds: []
        })
        .pipe(Effect.flip)
      expect(refused).toMatchObject({ reason: "conflict" })
      expect(yield* post(1)).toMatchObject({ messageId: expect.stringMatching(/^post:/) })
      expect(yield* sql`SELECT delivery_id FROM automation_deliveries`).toEqual([
        { delivery_id: postDeliveryId(1) }
      ])
    })
  )
})

it("a run whose Automation was paused after its chat ended posts nothing", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, posts, leaseOf } = yield* setup
      const lease = yield* leaseOf(1)
      yield* sql`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = ${automationId}`
      const refused = yield* posts
        .post({
          automationId,
          attemptId: 1,
          lease,
          runId: "run-1",
          spaceId: undefined,
          text: "After the pause",
          task: undefined,
          itemIds: []
        })
        .pipe(Effect.flip)
      expect(refused).toMatchObject({ reason: "conflict" })
      expect(yield* sql`SELECT 1 FROM automation_deliveries`).toEqual([])
    })
  )
})

it("a post to a Space whose inference is off arrives without its Task", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { sql, spaces, post, drain, message } = yield* setup
      const quiet = yield* spaces.create({ name: "Quiet" })
      yield* sql`UPDATE spaces SET inference_policy = json_set(inference_policy, '$.enabled', json('false'))
        WHERE space_id = ${quiet.space_id}`
      const posted = yield* post(1, {
        spaceId: quiet.space_id,
        text: "The bank wrote back.",
        task: { title: "Answer the bank", brief: "Answer the bank's letter." }
      })
      expect(yield* drain).toBe(1)
      expect(yield* message(posted.sessionId, posted.messageId)).toMatchObject({
        content: "The bank wrote back."
      })
      expect(yield* sql`SELECT 1 FROM space_tasks`).toEqual([])
    })
  )
})

it("a thread counts as owned for its sent mail only while its post is live, like a thread hit", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { thread, post, drain, spaces } = yield* setup
      const items = yield* ConnectionItemStore
      const taxes = yield* spaces.create({ name: "Taxes" })
      const owned = () =>
        items.threadOwned({ source: "gmail", account: "me@example.com", threadKey: "t-1" })
      const before = yield* owned()
      yield* thread("item-1", "t-1")
      yield* post(1, { itemIds: ["item-1"], spaceId: taxes.space_id })
      const pending = yield* owned()
      yield* drain
      const delivered = yield* owned()
      yield* spaces.archive(taxes.space_id)
      const archived = yield* owned()
      expect({ before, pending, delivered, archived }).toEqual({
        before: false,
        pending: true,
        delivered: true,
        archived: false
      })
    })
  )
})
