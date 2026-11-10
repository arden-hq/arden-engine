import { Clock, Effect, Layer, ManagedRuntime } from "effect"
import { PersistenceWriteQueue } from "../apps/server-ts/dist/persistence/write-queue.js"
import { createHash } from "node:crypto"
import { sqliteStoresLayer } from "../apps/server-ts/dist/persistence/sqlite/layer.js"
import { automationRulesLayer } from "../apps/server-ts/dist/automations/rules.js"
import { chatRulesLayer } from "../apps/server-ts/dist/chat/rules.js"
import { SessionStore } from "../apps/server-ts/dist/persistence/sessions/store.js"
import { ChatWriteStore } from "../apps/server-ts/dist/persistence/chat/store.js"

/** The server's stores over one database file, without the server: no restart
 *  recovery and no retention timer, so only the caller's writes happen. */
export const storesLayer = ({ databasePath, models }) =>
  sqliteStoresLayer({
    dataDir: null,
    filename: databasePath,
    models: { kind: "ready", host: models }
  }).pipe(
    Layer.provide(Layer.merge(automationRulesLayer, chatRulesLayer)),
    Layer.provide(PersistenceWriteQueue.layer)
  )

/** Offline fixture ingestion through production writers, never a generated replacement conversation. */
export async function importHistory({ databasePath, models, history }) {
  let fixtureTime = 0
  const liveClock = Effect.runSync(Clock.Clock)
  const fixtureClock = Layer.succeed(Clock.Clock, {
    ...liveClock,
    currentTimeMillisUnsafe: () => fixtureTime,
    currentTimeMillis: Effect.sync(() => fixtureTime),
    currentTimeNanosUnsafe: () => BigInt(fixtureTime) * 1000000n,
    currentTimeNanos: Effect.sync(() => BigInt(fixtureTime) * 1000000n)
  })
  const runtime = ManagedRuntime.make(
    storesLayer({ databasePath, models }).pipe(Layer.provideMerge(fixtureClock))
  )
  // The SQLite thread is unref'd and nothing else holds a process that has no
  // server yet, so a standalone caller would exit mid-import (unsettled await).
  const alive = setInterval(() => {}, 1_000)
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const chat = yield* ChatWriteStore
        const imported = []
        for (const source of history) {
          fixtureTime = Date.parse(source.date)
          if (!Number.isFinite(fixtureTime)) throw new Error("Invalid history date")
          const session = yield* sessions.create({ name: `${source.id} (${source.date})` })
          const messages = source.messages.map((message, index) => ({
            message_id: `${session.sessionId}-${index}`,
            role: message.role,
            content: message.content,
            created_at: new Date(source.date).toISOString(),
            ...(message.role === "user" ? { client_id: `${session.sessionId}-${index}` } : {})
          }))
          // Each fixture turn retains its supplied assistant text and date.
          for (let index = 0; index < messages.length;) {
            const user = messages[index]
            if (user.role !== "user")
              throw new Error("History must start each turn with a user message")
            let end = index + 1
            while (end < messages.length && messages[end].role !== "user") end += 1
            const turn = messages.slice(index + 1, end)
            if (!turn.length || turn.some((message) => message.role !== "assistant"))
              throw new Error("History requires user/assistant turns")
            const started = yield* chat.start({
              sessionId: session.sessionId,
              clientId: user.message_id,
              requestHash: createHash("sha256").update(JSON.stringify(user)).digest("hex"),
              assistantMessageId: turn[0].message_id,
              message: user
            })
            if (started._tag !== "Started")
              throw new Error("Fixture import unexpectedly reused a Run")
            yield* chat.finish({
              runId: started.runId,
              messages: [...started.activeMessages, ...turn],
              captureMemory: true
            })
            index = end
          }
          imported.push({ sourceId: source.id, sessionId: session.sessionId })
        }
        return imported
      })
    )
  } finally {
    await runtime.dispose().finally(() => clearInterval(alive))
  }
}
