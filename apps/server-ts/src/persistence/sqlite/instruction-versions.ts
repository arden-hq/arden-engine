import { DateTime, Effect } from "effect"

import {
  type InstructionChat,
  type InstructionVersion,
  InstructionVersionStore,
  InstructionVersionStoreError,
  type InstructionWriter
} from "../instructions/store.js"
import type { PersistenceDeps } from "./deps.js"

interface VersionRow {
  readonly version: number
  readonly content: string
  readonly digest: string
  readonly writer: string
  readonly session_id: string | null
  readonly run_id: string | null
  readonly restored_from: number | null
  readonly recorded_at: string
}

const corrupt = (row: VersionRow): InstructionVersionStoreError =>
  new InstructionVersionStoreError({
    operation: "read",
    reason: "corrupt",
    message: `Standing rules version ${row.version} has an unknown writer`
  })

const chatOf = (row: VersionRow): InstructionChat | undefined =>
  row.session_id === null || row.run_id === null
    ? undefined
    : { sessionId: row.session_id, runId: row.run_id }

const writerOf = (row: VersionRow): InstructionWriter | undefined => {
  switch (row.writer) {
    case "seed":
    case "outside":
      return { kind: row.writer }
    case "chat":
      return { kind: "chat", chat: chatOf(row) }
    case "restore":
      return row.restored_from === null
        ? undefined
        : { kind: "restore", chat: chatOf(row), from: row.restored_from }
    default:
      return undefined
  }
}

const versionOf = (
  row: VersionRow
): Effect.Effect<InstructionVersion, InstructionVersionStoreError> => {
  const writer = writerOf(row)
  return writer === undefined
    ? Effect.fail(corrupt(row))
    : Effect.succeed({
        version: row.version,
        content: row.content,
        digest: row.digest,
        writer,
        recordedAt: row.recorded_at
      })
}

const writerColumns = (writer: InstructionWriter) => {
  switch (writer.kind) {
    case "seed":
    case "outside":
      return { session: null, run: null, from: null }
    case "chat":
      return {
        session: writer.chat?.sessionId ?? null,
        run: writer.chat?.runId ?? null,
        from: null
      }
    case "restore":
      return {
        session: writer.chat?.sessionId ?? null,
        run: writer.chat?.runId ?? null,
        from: writer.from
      }
  }
}

const storage =
  (operation: InstructionVersionStoreError["operation"], message: string) => (cause: unknown) =>
    cause instanceof InstructionVersionStoreError
      ? cause
      : new InstructionVersionStoreError({ operation, reason: "storage", message, cause })

export const makeInstructionVersionStore = ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">): InstructionVersionStore["Service"] => {
  const one = (rows: ReadonlyArray<VersionRow>) => {
    const [row] = rows
    return row === undefined ? Effect.succeed(undefined) : versionOf(row)
  }
  return InstructionVersionStore.of({
    latest: () =>
      reader<VersionRow>`SELECT * FROM global_instruction_versions
        ORDER BY version DESC LIMIT 1`.pipe(
        Effect.flatMap(one),
        Effect.mapError(storage("read", "Could not read the standing rules history"))
      ),
    get: (version) =>
      reader<VersionRow>`SELECT * FROM global_instruction_versions WHERE version = ${version}`.pipe(
        Effect.flatMap(one),
        Effect.mapError(storage("read", "Could not read the standing rules history"))
      ),
    list: ({ limit }) =>
      Effect.gen(function* () {
        const rows = yield* reader<VersionRow>`SELECT * FROM global_instruction_versions
          ORDER BY version DESC LIMIT ${limit}`
        const [count] = yield* reader<{
          readonly total: number
        }>`SELECT COUNT(*) AS total FROM global_instruction_versions`
        return {
          versions: yield* Effect.forEach(rows, versionOf),
          total: count?.total ?? 0
        }
      }).pipe(Effect.mapError(storage("read", "Could not read the standing rules history"))),
    append: ({ content, digest, writer: by }) =>
      writer
        .transact(
          Effect.gen(function* () {
            const sql = writer.sql
            const recordedAt = DateTime.formatIso(yield* DateTime.now)
            const columns = writerColumns(by)
            const rows = yield* sql<VersionRow>`INSERT INTO global_instruction_versions
              (content, digest, writer, session_id, run_id, restored_from, recorded_at)
              VALUES (${content}, ${digest}, ${by.kind}, ${columns.session}, ${columns.run},
                ${columns.from}, ${recordedAt})
              RETURNING *`
            const [row] = rows
            if (row === undefined)
              return yield* new InstructionVersionStoreError({
                operation: "append",
                reason: "storage",
                message: "The standing rules version was not saved"
              })
            return yield* versionOf(row)
          })
        )
        .pipe(Effect.mapError(storage("append", "Could not save a standing rules version")))
  })
}
