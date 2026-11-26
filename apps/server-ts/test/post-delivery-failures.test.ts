import { Effect } from "effect"
import { expect, it } from "vitest"
import { ConnectionItemStore } from "../src/persistence/connections/store.js"
import { postDeliveryId } from "../src/persistence/sqlite/run-post.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { AT, automationId, setup } from "./post-delivery-kit.js"

it("a post that keeps failing is set aside and stops holding its chat", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const { post, drain, delivery, posts } = yield* setup
      yield* post(1)
      yield* post(2)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((yield* delivery(1))?.status === "discarded") break
        yield* posts.defer({ deliveryId: postDeliveryId(1), attempt }, "failed")
      }
      expect(yield* delivery(1)).toMatchObject({ status: "discarded", reason: "undeliverable" })
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
      const quiet = yield* spaces.create({ name: "Quiet", instructions: { kind: "unwritten" } })
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
      const taxes = yield* spaces.create({ name: "Taxes", instructions: { kind: "unwritten" } })
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
