import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryShape
} from "@arden-hq/revisions/effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"

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
 * The rules for a replay on the copy, kept here so each test follows them by
 * calling this file, not by a note:
 *
 * - One test file at a time. Vitest runs files at once and there is one copy, so
 *   a migration or write on it in one file refuses another's ("database is
 *   locked"). Every connection to the copy opens inside `holdingReplayCopy`.
 * - The engine's own stores write. `runOnReplayCopy` adds a read-only connection
 *   for queries no store answers.
 */

/** Runs `body` while this process alone holds the copy, across vitest workers. */
const holdingReplayCopy = async <A>(copy: ReplayFolder, body: () => Promise<A>) => {
  const lock = join(
    tmpdir(),
    `arden-replay-${createHash("sha256").update(copy.database).digest("hex").slice(0, 16)}.lock`
  )
  for (;;) {
    const taken = takeLock(lock)
    if (taken) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  try {
    return await body()
  } finally {
    rmSync(lock, { force: true })
  }
}

/** Creates the lock file, or clears one whose process is gone. A lock with no
 * process number yet is being written, and is left alone. */
const takeLock = (lock: string): boolean => {
  try {
    const handle = openSync(lock, "wx")
    writeSync(handle, String(process.pid))
    closeSync(handle)
    return true
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") throw cause
  }
  const holder = readHolder(lock)
  if (holder !== undefined && !processAlive(holder)) rmSync(lock, { force: true })
  return false
}

const readHolder = (lock: string): number | undefined => {
  try {
    const holder = Number(readFileSync(lock, "utf8"))
    return Number.isInteger(holder) && holder > 0 ? holder : undefined
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined
    throw cause
  }
}

const errorCode = (cause: unknown): unknown =>
  cause instanceof Error && "code" in cause ? cause.code : undefined

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return errorCode(cause) !== "ESRCH"
  }
}

/**
 * Runs `body` against the copy with the engine's own stores, after the same
 * migrations the server runs at start. Nothing else starts: no server, no
 * scheduler, no model, and `fetch` refuses while the body runs. The extra
 * `SqlClient` is a read-only connection for queries no store answers.
 */
export const runOnReplayCopy = async <A, E>(
  copy: ReplayFolder,
  body: Effect.Effect<A, E, SqlitePersistence | SqlClient.SqlClient>
): Promise<A> => {
  const { database } = assertReplayFolder(copy.folder)
  return holdingReplayCopy(copy, async () => {
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
  })
}

