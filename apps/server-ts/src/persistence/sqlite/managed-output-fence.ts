import { randomUUID } from "node:crypto"
import { Effect, Predicate } from "effect"
import type { Writer } from "./deps.js"

const active = new Set<string>()

const ownerAlive = (pid: number): boolean => {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return !Predicate.hasProperty(cause, "code") || cause.code !== "ESRCH"
  }
}

export interface ManagedOutputFence {
  readonly run: <A>(action: () => Promise<A>) => Promise<A>
  readonly drain: () => Promise<void>
}

export const makeManagedOutputFence = (writer: Writer): ManagedOutputFence => {
  const sql = writer.sql
  const operations = new Set<Promise<unknown>>()
  let closing = false
  const claim = Effect.fn("ManagedOutputFence.claim")(function* (token: string) {
    return yield* writer.transact(
      Effect.gen(function* () {
        yield* sql`INSERT INTO managed_output_lifecycle_lock (singleton_id, generation)
          VALUES (1, 0) ON CONFLICT(singleton_id) DO NOTHING`
        const rows = yield* sql<{
          readonly holder_pid: number | null
          readonly holder_token: string | null
        }>`SELECT holder_pid, holder_token FROM managed_output_lifecycle_lock WHERE singleton_id = 1`
        const row = rows[0]
        if (row === undefined) throw new Error("Managed-output fence is missing")
        if (row.holder_pid !== null && row.holder_token !== null) {
          const ours = row.holder_pid === process.pid
          const held = ours ? active.has(row.holder_token) : ownerAlive(row.holder_pid)
          if (held) return false
        }
        yield* sql`UPDATE managed_output_lifecycle_lock
          SET generation = generation + 1, holder_pid = ${process.pid}, holder_token = ${token}
          WHERE singleton_id = 1`
        return true
      })
    )
  })
  const acquire = Effect.fn("ManagedOutputFence.acquire")(function* (token: string) {
    while (!(yield* claim(token))) yield* Effect.sleep("10 millis")
  })
  const release = Effect.fn("ManagedOutputFence.release")(function* (token: string) {
    yield* writer.transact(sql`UPDATE managed_output_lifecycle_lock
      SET holder_pid = NULL, holder_token = NULL
      WHERE singleton_id = 1 AND holder_pid = ${process.pid} AND holder_token = ${token}`)
  })
  const run: ManagedOutputFence["run"] = (action) => {
    if (closing) return Promise.reject(new Error("Managed-output lifecycle is closing"))
    const token = randomUUID()
    active.add(token)
    const operation = (async () => {
      try {
        await Effect.runPromise(acquire(token))
        try {
          return await action()
        } finally {
          await Effect.runPromise(release(token))
        }
      } finally {
        active.delete(token)
      }
    })()
    operations.add(operation)
    void operation.finally(() => operations.delete(operation)).catch(() => undefined)
    return operation
  }
  return {
    run,
    drain: async () => {
      closing = true
      while (operations.size > 0) await Promise.allSettled([...operations])
    }
  }
}
