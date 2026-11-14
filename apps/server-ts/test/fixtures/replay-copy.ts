import { existsSync } from "node:fs"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import {
  assertReplayFolder,
  REPLAY_COPY_VARIABLE,
  type ReplayFolder
} from "../../scripts/replay-folder.js"
import type { SqlitePersistence } from "../../src/persistence/sqlite/layer.js"
import { PersistenceWriteQueue } from "../../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./temp-database.js"

export type ReplayCopy =
  | { readonly kind: "present"; readonly copy: ReplayFolder }
  | { readonly kind: "absent"; readonly reason: string }

/**
 * The replay copy named by `ARDEN_REPLAY_COPY`, made by `just replay-copy`.
 * Absent when the variable is unset or the folder holds no copy, so the normal
 * suite never depends on private data. A folder that fails the guard throws.
 */
export const locateReplayCopy = (): ReplayCopy => {
  const folder = process.env[REPLAY_COPY_VARIABLE]?.trim() ?? ""
  if (folder === "")
    return {
      kind: "absent",
      reason: `${REPLAY_COPY_VARIABLE} is not set. Run \`just replay-copy <folder>\` and set it to that folder to replay on real data.`
    }
  const copy = assertReplayFolder(folder)
  if (!existsSync(copy.database))
    return {
      kind: "absent",
      reason: `No replay copy at ${copy.database}. Run \`just replay-copy ${copy.folder}\`.`
    }
  return { kind: "present", copy }
}

const refuseNetwork = (): Promise<never> =>
  Promise.reject(new Error("A replay on the copy must not reach the network"))

/**
 * Runs `body` against the copy with the engine's own stores, after the same
 * migrations the server runs at start. Nothing else starts: no server, no
 * scheduler, no model, and `fetch` refuses while the body runs. The extra
 * `SqlClient` is a read-only connection for queries no store answers; every
 * write goes through a store.
 */
export const runOnReplayCopy = async <A, E>(
  copy: ReplayFolder,
  body: Effect.Effect<A, E, SqlitePersistence | SqlClient.SqlClient>
): Promise<A> => {
  const { database } = assertReplayFolder(copy.folder)
  const fetch = globalThis.fetch
  globalThis.fetch = refuseNetwork
  try {
    return await Effect.runPromise(
      body.pipe(
        Effect.provide(
          // The read-only connection opens after the stores: a pending
          // migration refuses to run while another connection is open.
          SqliteClient.layer({ filename: database, readonly: true }).pipe(
            Layer.provideMerge(
              sqlitePersistenceLayer({ dataDir: null, filename: database }).pipe(
                Layer.provide(PersistenceWriteQueue.layer)
              )
            )
          )
        )
      )
    )
  } finally {
    globalThis.fetch = fetch
  }
}
