import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { eventsHandler } from "../src/automations/handlers/events.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { PostStore, type PostInput } from "../src/persistence/posts/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { postDeliveryId } from "../src/persistence/sqlite/run-post.js"

export const AT = "2026-11-20T00:00:00.000Z"
export const automationId = eventsHandler.spec.automationId

export const setup = Effect.gen(function* () {
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
