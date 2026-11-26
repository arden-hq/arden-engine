import { captureMutationVersions } from "./mutation-links.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { recordedHistoryReader } from "./recorded-history.js"
import { DEFAULT_TASK_INFERENCE_POLICY, type CreateSpaceInput } from "@arden-hq/protocol/spaces"
import { CreateSpaceInputSchema } from "@arden-hq/protocol/effect/spaces"
import { DateTime, Effect, Schema } from "effect"
import {
  SpaceStore,
  SpaceStoreError,
  type FreeSpacePage,
  type PersistedSpace,
  type SpaceBindingRow
} from "../spaces/store.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { nextId } from "./deps.js"
import type { PersistenceDeps } from "./deps.js"
import { restoreSpaceChats } from "./space-chat-archive.js"
import { makeSpaceReads, makeSpaceLists } from "./space-read.js"
import { decodeRow, storeError, type SpaceRow } from "./space-row.js"
import { instructionsColumns } from "./space-changes.js"
import { makeSpaceArchive } from "./space-archive.js"
import { makeSpaceUpdate, strict } from "./space-update.js"

const generatedInstructionsSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(20_000)
)

export const makeSpaceStore = ({
  writer,
  sessionEvents,
  reader
}: Pick<PersistenceDeps, "writer" | "sessionEvents" | "reader">): SpaceStore["Service"] => {
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
  const activeBindings = Effect.fn("SqliteSpaceStore.activeBindings")(function* () {
    return yield* sql<SpaceBindingRow>`
      SELECT space_id, page_id, page_path
      FROM spaces
      WHERE archived_at IS NULL AND (page_id IS NOT NULL OR page_path IS NOT NULL)
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          "page_binding",
          "storage",
          "Could not read the Spaces' Memory pages",
          undefined,
          cause
        )
      )
    )
  })

  const { list, listArchived } = makeSpaceLists(sql)

  const create = Effect.fn("SqliteSpaceStore.create")(function* (
    input: CreateSpaceInput,
    mutation?: MutationOperationIdentity
  ): Effect.fn.Return<PersistedSpace, SpaceStoreError> {
    const valid = yield* Schema.decodeUnknownEffect(CreateSpaceInputSchema)(input, strict).pipe(
      Effect.mapError((cause) => storeError("create", "invalid", "Invalid Space", undefined, cause))
    )
    const name = valid.name
    const nameKey = name.toLowerCase()
    const { instructions, instructions_source: instructionsSource } = instructionsColumns(
      valid.instructions
    )

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const existing = yield* sql<SpaceRow>`
        SELECT space_id, name, instructions, instructions_source, page_path, page_id,
               inference_policy, mark, kind, created_at, updated_at, archived_at
        FROM spaces
        WHERE name_key = ${nameKey} AND archived_at IS NULL
        LIMIT 1
      `.pipe(
            Effect.mapError((cause) =>
              storeError("create", "storage", "Could not find an existing Space", undefined, cause)
            )
          )
          if (existing[0] !== undefined)
            return yield* storeError(
              "create",
              "conflict",
              "An active Space already has that name. Pick another.",
              existing[0].space_id
            )

          const spaceId = yield* nextId
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "space",
            id: spaceId,
            identity: mutation
          })
          const timestamp = DateTime.formatIso(yield* DateTime.now)
          const created = yield* sql<SpaceRow>`
        INSERT INTO spaces (
          space_id, name, name_key, instructions, instructions_source,
          page_path, page_id, inference_policy, created_at, updated_at, archived_at
        ) VALUES (
          ${spaceId}, ${name}, ${nameKey}, ${instructions}, ${instructionsSource},
          NULL, NULL, ${JSON.stringify(DEFAULT_TASK_INFERENCE_POLICY)}, ${timestamp}, ${timestamp}, NULL
        )
        RETURNING space_id, name, instructions, instructions_source, page_path, page_id,
                  inference_policy, mark, kind, created_at, updated_at, archived_at
      `.pipe(
            Effect.mapError((cause) =>
              storeError("create", "storage", "Could not create Space", spaceId, cause)
            )
          )
          yield* recordVersions
          const row = created[0]
          return row === undefined
            ? yield* storeError("create", "storage", "Created Space was not returned", spaceId)
            : yield* decodeRow(row, "create")
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SpaceStoreError
            ? cause
            : storeError("create", "storage", "Could not complete Space creation", undefined, cause)
        )
      )
  })

  const get = Effect.fn("SqliteSpaceStore.get")(function* (
    spaceId: string,
    includeArchived = false
  ): Effect.fn.Return<PersistedSpace | null, SpaceStoreError> {
    const validSpaceId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(spaceId).pipe(
      Effect.mapError((cause) =>
        storeError("get", "invalid", "Space id must not be empty", undefined, cause)
      )
    )
    const rows = yield* sql<SpaceRow>`
      SELECT space_id, name, instructions, instructions_source, page_path, page_id,
             inference_policy, mark, kind, created_at, updated_at, archived_at
      FROM spaces
      WHERE space_id = ${validSpaceId}
        AND (${includeArchived ? 1 : 0} = 1 OR archived_at IS NULL)
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError("get", "storage", "Could not load Space", validSpaceId, cause)
      )
    )
    return rows[0] === undefined ? null : yield* decodeRow(rows[0], "get")
  })

  const { overview, detail } = makeSpaceReads(reader)

  const update = makeSpaceUpdate({ writer, spaceJobs })
  const setGeneratedInstructions = Effect.fn("SqliteSpaceStore.setGeneratedInstructions")(
    function* (
      spaceId: string,
      instructions: string
    ): Effect.fn.Return<PersistedSpace | null, SpaceStoreError> {
      const validSpaceId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(spaceId).pipe(
        Effect.mapError((cause) =>
          storeError("update", "invalid", "Space id must not be empty", undefined, cause)
        )
      )
      const valid = yield* Schema.decodeUnknownEffect(generatedInstructionsSchema)(
        instructions
      ).pipe(
        Effect.mapError((cause) =>
          storeError(
            "update",
            "invalid",
            "Arden’s draft of the Space instructions was not usable. Try again.",
            validSpaceId,
            cause
          )
        )
      )
      const now = DateTime.formatIso(yield* DateTime.now)
      return yield* writer
        .transact(
          Effect.gen(function* () {
            const updated = yield* sql<SpaceRow>`
        UPDATE spaces
        SET instructions = ${valid}, instructions_source = 'generated', updated_at = ${now}
        WHERE space_id = ${validSpaceId}
          AND archived_at IS NULL
          AND (instructions_source IS NULL OR instructions_source = 'generated')
          AND instructions IS NOT ${valid}
        RETURNING space_id, name, instructions, instructions_source, page_path, page_id,
                  inference_policy, mark, kind, created_at, updated_at, archived_at
      `
            const next = updated[0]
            if (next === undefined) return yield* get(validSpaceId)
            yield* spaceJobs.queueOwnerSpaceChangeWake(validSpaceId, now, undefined)
            return yield* decodeRow(next, "update")
          })
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof SpaceStoreError
              ? cause
              : storeError(
                  "update",
                  "storage",
                  "Could not store generated Space instructions",
                  validSpaceId,
                  cause
                )
          )
        )
    }
  )

  const recordLetterSubject = Effect.fn("SqliteSpaceStore.recordLetterSubject")(function* (
    sessionId: string,
    messageId: string,
    subject: string
  ): Effect.fn.Return<void, SpaceStoreError> {
    yield* writer
      .run(
        sql`
      INSERT OR REPLACE INTO letter_subjects (session_id, message_id, subject)
      SELECT m.session_id, m.message_id, ${subject}
      FROM session_messages AS m
      JOIN sessions AS s ON s.session_id = m.session_id
      WHERE m.session_id = ${sessionId}
        AND m.message_id = ${messageId}
        AND s.space_id IS NOT NULL
    `
      )
      .pipe(
        Effect.mapError((cause) =>
          storeError("update", "storage", "Could not store the letter subject", undefined, cause)
        ),
        Effect.asVoid
      )
  })

  const linkChat = Effect.fn("SqliteSpaceStore.linkChat")(function* (
    spaceId: string,
    sessionId: string,
    throughSequence: number
  ): Effect.fn.Return<boolean, SpaceStoreError> {
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now)
          return yield* spaceJobs.linkChat(spaceId, sessionId, throughSequence, now)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          storeError("update", "storage", "Could not link the chat to the Space", spaceId, cause)
        )
      )
  })

  const unlinkedSpaces = Effect.fn("SqliteSpaceStore.unlinkedSpaces")(function* (
    sessionId: string,
    throughSequence: number,
    spaceIds: ReadonlyArray<string>
  ): Effect.fn.Return<ReadonlyArray<string>, SpaceStoreError> {
    return yield* writer
      .transact(spaceJobs.unlinkedSpaces(sessionId, throughSequence, spaceIds))
      .pipe(
        Effect.mapError((cause) =>
          storeError("update", "storage", "Could not read the chat's Space links", undefined, cause)
        )
      )
  })

  const setPinned = Effect.fn("SqliteSpaceStore.setPinned")(function* (
    spaceIds: ReadonlyArray<string>
  ): Effect.fn.Return<void, SpaceStoreError> {
    yield* writer
      .transact(
        Effect.gen(function* () {
          yield* sql`UPDATE spaces SET pinned_position = NULL WHERE pinned_position IS NOT NULL`
          for (const [position, spaceId] of [...new Set(spaceIds)].entries())
            yield* sql`UPDATE spaces SET pinned_position = ${position}
                       WHERE space_id = ${spaceId} AND archived_at IS NULL`
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          storeError("update", "storage", "Could not save the Spaces' order", undefined, cause)
        )
      )
  })

  const releaseFromArchived = (pageId: string, pagePath: string, now: string) => sql`
    UPDATE spaces
    SET page_id = NULL, page_path = NULL, updated_at = ${now}
    WHERE archived_at IS NOT NULL AND (page_id = ${pageId} OR page_path = ${pagePath})
  `

  const bindPage = Effect.fn("SqliteSpaceStore.bindPage")(function* (
    spaceId: string,
    { pageId, pagePath }: FreeSpacePage
  ): Effect.fn.Return<PersistedSpace | null, SpaceStoreError> {
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const current = yield* get(spaceId)
          if (current === null) return null
          if (current.page_id === pageId && current.page_path === pagePath) return current
          yield* releaseFromArchived(pageId, pagePath, now)
          const rows = yield* sql<SpaceRow>`
        UPDATE spaces
        SET page_id = ${pageId}, page_path = ${pagePath}, updated_at = ${now}
        WHERE space_id = ${spaceId} AND archived_at IS NULL
        RETURNING space_id, name, instructions, instructions_source, page_path, page_id,
                  inference_policy, mark, kind, created_at, updated_at, archived_at
      `
          yield* spaceJobs.syncSpace(spaceId, now)
          return rows[0] === undefined ? null : yield* decodeRow(rows[0], "page")
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SpaceStoreError
            ? cause
            : storeError("page", "storage", "Could not bind Space page", spaceId, cause)
        )
      )
  })

  const archive = makeSpaceArchive({ writer, sessionEvents, spaceJobs })
  const restore = Effect.fn("SqliteSpaceStore.restore")(function* (
    spaceId: string,
    page: FreeSpacePage | null
  ): Effect.fn.Return<PersistedSpace | null, SpaceStoreError> {
    const validSpaceId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(spaceId).pipe(
      Effect.mapError((cause) =>
        storeError("restore", "invalid", "Space id must not be empty", undefined, cause)
      )
    )
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const archived = yield* sql<SpaceRow>`
        SELECT space_id, name, instructions, instructions_source, page_path, page_id,
               inference_policy, mark, kind, created_at, updated_at, archived_at
        FROM spaces
        WHERE space_id = ${validSpaceId} AND archived_at IS NOT NULL
        LIMIT 1
      `
          const row = archived[0]
          if (row === undefined) return null
          const duplicate = yield* sql<{ readonly space_id: string }>`
        SELECT space_id FROM spaces
        WHERE name_key = ${row.name.toLowerCase()}
          AND space_id != ${validSpaceId}
          AND archived_at IS NULL
        LIMIT 1
      `
          if (duplicate.length > 0) {
            return yield* storeError(
              "restore",
              "conflict",
              "An active Space already has that name. Pick another.",
              validSpaceId
            )
          }
          if (page !== null) yield* releaseFromArchived(page.pageId, page.pagePath, now)
          const restored = yield* sql<SpaceRow>`
        UPDATE spaces
        SET archived_at = NULL, page_id = ${page?.pageId ?? null},
          page_path = ${page?.pagePath ?? null}, updated_at = ${now}
        WHERE space_id = ${validSpaceId} AND archived_at IS NOT NULL
        RETURNING space_id, name, instructions, instructions_source, page_path, page_id,
                  inference_policy, mark, kind, created_at, updated_at, archived_at
      `
          const next = restored[0]
          if (next === undefined) return null
          yield* restoreSpaceChats(sql, validSpaceId)
          yield* spaceJobs.queueOwnerSpaceChangeWake(validSpaceId, now, undefined)
          return yield* decodeRow(next, "restore")
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SpaceStoreError
            ? cause
            : storeError("restore", "storage", "Could not restore Space", validSpaceId, cause)
        )
      )
  })

  return SpaceStore.of({
    history: recordedHistoryReader({ writer, reader }, "space"),
    list,
    listArchived,
    create,
    get,
    update,
    setGeneratedInstructions,
    bindPage,
    archive,
    restore,
    detail,
    recordLetterSubject,
    linkChat,
    unlinkedSpaces,
    overview,
    setPinned,
    activeBindings
  })
}
