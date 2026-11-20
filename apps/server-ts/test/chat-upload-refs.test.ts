import { ROLE } from "@arden-hq/std/message-vocabulary"
import { mkdtemp, rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { ManagedOutputLifecycleStore } from "../src/persistence/managed-output/lifecycle-store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { CHAT_UPLOAD_MESSAGES_BACKFILL } from "../src/persistence/sqlite/chat-upload-messages.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"

const NAMED = "11111111-1111-4111-8111-111111111111"
const UNNAMED = "22222222-2222-4222-8222-222222222222"

const persistence = (filename: string) =>
  recoveredSqlitePersistenceLayer({ dataDir: null, filename }).pipe(
    Layer.provide(PersistenceWriteQueue.layer)
  )

const withDatabase = <A>(filename: string, use: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(filename)
  try {
    return use(database)
  } finally {
    database.close()
  }
}

// Upload cleanup must learn who names an upload from the link written when
// the message is stored, not by reading message text.
it("keeps an upload a stored message names and frees it when the message goes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-upload-refs-"))
  const filename = join(directory, "arden.db")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const chat = yield* ChatWriteStore
        const lifecycle = yield* ManagedOutputLifecycleStore
        const session = yield* sessions.create({ name: "Uploads" })
        yield* chat.start({
          sessionId: session.sessionId,
          clientId: "upload-user",
          requestHash: "upload-user-hash",
          assistantMessageId: "upload-user-assistant",
          message: {
            message_id: "upload-user",
            client_id: "upload-user",
            role: ROLE.user,
            content: `Look at /tmp/arden/uploads/${NAMED}/photo.png`,
            created_at: "2026-09-01T00:00:00.000Z"
          }
        })
        yield* Effect.promise(() => lifecycle.queueUploads([NAMED, UNNAMED]))
      }).pipe(Effect.provide(persistence(filename)))
    )
    withDatabase(filename, (database) => {
      expect(database.prepare("SELECT count(*) AS n FROM chat_upload_unlisted").get()?.n).toBe(1)
      database
        .prepare(
          `INSERT INTO data_backfills (name, converted, started_at, updated_at, finished_at)
           VALUES (?, 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
             '2026-09-01T00:00:00.000Z')
           ON CONFLICT(name) DO UPDATE SET finished_at = excluded.finished_at`
        )
        .run(CHAT_UPLOAD_MESSAGES_BACKFILL)
    })

    const decided = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* ManagedOutputLifecycleStore
        return {
          named: yield* Effect.promise(() => lifecycle.decideUpload(NAMED)),
          unnamed: yield* Effect.promise(() => lifecycle.decideUpload(UNNAMED))
        }
      }).pipe(Effect.provide(persistence(filename)))
    )
    expect(decided).toEqual({ named: "kept", unnamed: "remove" })

    withDatabase(filename, (database) => {
      expect(
        database
          .prepare("SELECT upload_id FROM chat_upload_refs")
          .all()
          .map((row) => row.upload_id)
      ).toEqual([NAMED])
      expect(database.prepare("SELECT count(*) AS n FROM chat_upload_unlisted").get()?.n).toBe(0)
      database.prepare("DELETE FROM session_messages WHERE role = 'user'").run()
      expect(database.prepare("SELECT count(*) AS n FROM chat_upload_refs").get()?.n).toBe(0)
    })

    const afterDelete = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* ManagedOutputLifecycleStore
        yield* Effect.promise(() => lifecycle.queueUploads([NAMED]))
        return yield* Effect.promise(() => lifecycle.decideUpload(NAMED))
      }).pipe(Effect.provide(persistence(filename)))
    )
    expect(afterDelete).toBe("remove")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
