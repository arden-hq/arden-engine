import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"

import { AnswerBlockStore } from "../src/persistence/answer-blocks/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"

const AT = "2026-10-10T00:00:00.000Z"
const BLOCK = 'root = Stack([s])\n$runs = 12\ns = Slider("Runs", 1, 30, 1, $runs, "runs")'
const ANSWER = `Here it is.\n\n\`\`\`arden:ui\n${BLOCK}\n\`\`\``

it("saves a block's declared values only for a standing assistant message of that chat", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "arden-answer-blocks-"))
  const filename = path.join(directory, "arden.db")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const blocks = yield* AnswerBlockStore
        const database = new DatabaseSync(filename)
        database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity)
          VALUES ('chat', 'chat-ref', '${AT}', '${AT}'), ('other', 'other-ref', '${AT}', '${AT}')`)
        database
          .prepare(
            `INSERT INTO session_messages (session_id, message_id, seq, role, message_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run("chat", "answer", 0, "assistant", JSON.stringify({ content: ANSWER }), AT)
        database
          .prepare(
            `INSERT INTO session_messages (session_id, message_id, seq, role, message_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            "chat",
            "replaced",
            1,
            "assistant",
            JSON.stringify({ content: ANSWER, superseded: true }),
            AT
          )
        database.close()
        const save = (sessionId: string, blockIndex: number, messageId = "answer") =>
          blocks
            .save({
              sessionId,
              messageId,
              blockIndex,
              state: { $runs: 99, $other: 1 }
            })
            .pipe(
              Effect.map((saved) => saved.state),
              Effect.catchTag("AnswerBlockStoreError", (error) => Effect.succeed(error.reason))
            )

        expect(yield* save("chat", 0)).toEqual({ $runs: 30 })
        expect(yield* save("other", 0)).toBe("not_found")
        expect(yield* save("chat", 1)).toBe("not_found")
        expect(yield* save("chat", 0, "replaced")).toBe("not_found")
        expect(yield* blocks.list("chat")).toEqual([
          { messageId: "answer", blockIndex: 0, state: { $runs: 30 } }
        ])
        expect(yield* blocks.list("other")).toEqual([])
      }).pipe(
        Effect.provide(
          sqlitePersistenceLayer({ dataDir: null, filename }).pipe(
            Layer.provide(PersistenceWriteQueue.layer)
          )
        )
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
