import { writeFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { makeWriter } from "../../dist/persistence/sqlite/deps.js"
import { makeManagedOutputLifecycleStore } from "../../dist/persistence/sqlite/managed-output-lifecycle.js"
import { PersistenceWriteQueue } from "../../dist/persistence/write-queue.js"
import { makeManagedObjectStore } from "../../dist/artifacts/managed-output/object-store.js"

const [mode, filename, root, sessionId, marker] = process.argv.slice(2)
if (
  !filename ||
  !root ||
  !sessionId ||
  !marker ||
  !["publish-first", "delete-first", "filesystem-failure", "lease-crash"].includes(mode)
)
  throw new Error("Invalid managed-output process fixture arguments")

const released = () =>
  new Promise((resolve) => {
    process.stdin.once("end", resolve)
    process.stdin.resume()
  })

await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const queue = yield* PersistenceWriteQueue
    const lifecycle = makeManagedOutputLifecycleStore({
      writer: makeWriter({ sql, reader: sql, queue }),
      reader: sql
    })
    if (mode === "delete-first") {
      process.stdout.write("READY\n")
      yield* Effect.promise(released)
    }
    yield* Effect.promise(async () => {
      try {
        await lifecycle.withLiveSession(sessionId, async () => {
          if (mode === "publish-first") {
            await makeManagedObjectStore(root).publish({
              sessionId,
              text: "published before delete\n".repeat(6000),
              format: "text",
              source: { kind: "tool", name: "fixture", call_id: "first" }
            })
          }
          process.stdout.write(mode === "lease-crash" ? "LEASED\n" : "LOCKED\n")
          await released()
          if (mode === "filesystem-failure") throw new Error("synthetic filesystem failure")
        })
        throw new Error("Deleted Session unexpectedly allowed publication")
      } catch (cause) {
        const expected =
          mode === "filesystem-failure" ? "synthetic filesystem failure" : "no longer exists"
        if (!(cause instanceof Error) || !cause.message.includes(expected)) throw cause
        await writeFile(marker, mode === "filesystem-failure" ? "failed" : "denied")
        process.stdout.write("SETTLED\n")
      }
    })
  }).pipe(
    Effect.provide(Layer.merge(SqliteClient.layer({ filename }), PersistenceWriteQueue.layer))
  )
)
