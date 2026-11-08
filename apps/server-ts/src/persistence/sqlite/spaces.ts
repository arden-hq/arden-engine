import { captureMutationVersions } from "./mutation-links.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { recordedHistoryReader } from "./recorded-history.js"
import {
  DEFAULT_TASK_INFERENCE_POLICY,
  type CreateSpaceInput,
  type SpaceArchiveResponse,
  type UpdateSpaceInput
} from "@arden-hq/protocol/spaces"
import { assertPersonRun } from "./person-run.js"
import {
  CreateSpaceInputSchema,
  SpaceArchiveResponseSchema,
  UpdateSpaceInputSchema
} from "@arden-hq/protocol/effect/spaces"
import { DateTime, Effect, Schema } from "effect"
import {
  SpaceStore,
  SpaceStoreError,
  KEEP_ONE_SPACE,
  type PersistedSpace
} from "../spaces/store.js"
import {
  canonicalWikiPath,
  wikiSpaceBoundariesOverlap,
  wikiPathWithinSpaceBoundary
} from "../../wiki/authority.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { renameOwnedJob } from "./job-labels.js"
import { spaceJobId } from "../space-job-id.js"
import { nextId } from "./deps.js"
import type { PersistenceDeps } from "./deps.js"
import { pauseForArchivedSpace } from "./automation-auto-pause.js"
import { archiveSpaceChats, restoreSpaceChats } from "./space-chat-archive.js"
import { chatHasActiveWork } from "./session-archive.js"
import { makeSpaceReads, makeSpaceLists } from "./space-read.js"
import { decodeRow, storeError, type SpaceRow } from "./space-row.js"

const strict = { onExcessProperty: "error" } as const
const generatedInstructionsSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(20_000)
)

const optionalText = (value: string | null | undefined): string | null => value?.trim() || null

export const makeSpaceStore = ({
  writer,
  sessionEvents,
  reader
}: Pick<PersistenceDeps, "writer" | "sessionEvents" | "reader">): SpaceStore["Service"] => {
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
  const ownsWikiPath = Effect.fn("SqliteSpaceStore.ownsWikiPath")(function* (path: string) {
    const rows = yield* sql<{
      readonly page_id: string | null
      readonly page_path: string | null
    }>`
      SELECT page_id, page_path
      FROM spaces
      WHERE page_id IS NOT NULL OR page_path IS NOT NULL
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          "page_binding",
          "storage",
          "Could not resolve Space Wiki ownership",
          undefined,
          cause
        )
      )
    )
    return rows.some((row) => {
      if (row.page_id === null || row.page_path === null) return true
      if (canonicalWikiPath(row.page_path) === undefined) return true
      return wikiPathWithinSpaceBoundary(row.page_path, path)
    })
  })

  const hasPageBinding = Effect.fn("SqliteSpaceStore.hasPageBinding")(function* (
    pageId: string,
    path: string
  ) {
    const rows = yield* sql<{ readonly space_id: string }>`
      SELECT space_id
      FROM spaces
      WHERE page_id = ${pageId} OR page_path = ${path}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          "page_binding",
          "storage",
          "Could not check Space page ownership",
          undefined,
          cause
        )
      )
    )
    return rows.length > 0
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
    const instructions = optionalText(valid.instructions)
    const instructionsSource = Object.hasOwn(valid, "instructions") ? "manual" : null

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const existing = yield* sql<SpaceRow>`
        SELECT space_id, name, instructions, instructions_source, page_path, page_id,
               inference_policy, mark, created_at, updated_at, archived_at
        FROM spaces
        WHERE name_key = ${nameKey} AND archived_at IS NULL
        LIMIT 1
      `.pipe(
            Effect.mapError((cause) =>
              storeError("create", "storage", "Could not find an existing Space", undefined, cause)
            )
          )
          if (existing[0] !== undefined) return yield* decodeRow(existing[0], "create")

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
                  inference_policy, mark, created_at, updated_at, archived_at
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
             inference_policy, mark, created_at, updated_at, archived_at
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

  const update = Effect.fn("SqliteSpaceStore.update")(function* (
    spaceId: string,
    input: UpdateSpaceInput,
    runId?: string,
    toolCallId?: string
  ): Effect.fn.Return<PersistedSpace | null, SpaceStoreError> {
    const validSpaceId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(spaceId).pipe(
      Effect.mapError((cause) =>
        storeError("update", "invalid", "Space id must not be empty", undefined, cause)
      )
    )
    const valid = yield* Schema.decodeUnknownEffect(UpdateSpaceInputSchema)(input, strict).pipe(
      Effect.mapError((cause) =>
        storeError("update", "invalid", "Invalid Space update", validSpaceId, cause)
      )
    )
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "space",
            id: validSpaceId,
            identity:
              runId !== undefined && toolCallId !== undefined ? { runId, toolCallId } : undefined
          })
          if (runId !== undefined)
            yield* assertPersonRun(sql, runId).pipe(
              Effect.mapError((cause) =>
                storeError("update", "conflict", cause.message, validSpaceId, cause)
              )
            )
          const rows = yield* sql<SpaceRow & { readonly policy_generation: number }>`
        SELECT space_id, name, instructions, instructions_source, page_path, page_id,
               inference_policy, mark, created_at, updated_at, archived_at,
               policy_generation
        FROM spaces
        WHERE space_id = ${validSpaceId} AND archived_at IS NULL
        LIMIT 1
      `
          const row = rows[0]
          if (row === undefined) return null
          const current = yield* decodeRow(row, "update")
          if (
            valid.expected_updated_at !== undefined &&
            valid.expected_updated_at !== current.updated_at
          ) {
            return yield* storeError(
              "update",
              "conflict",
              "This Space changed. Reload it and try again.",
              validSpaceId
            )
          }
          const updatedAt =
            now > current.updated_at
              ? now
              : DateTime.formatIso(
                  DateTime.add(DateTime.makeUnsafe(current.updated_at), { milliseconds: 1 })
                )
          if (Object.hasOwn(valid, "page_path") && valid.page_path !== current.page_path) {
            return yield* storeError(
              "update",
              "conflict",
              "Change the Space’s Memory page from the Memory page controls.",
              validSpaceId
            )
          }
          const name = valid.name ?? current.name
          const nameKey = name.toLowerCase()
          const duplicate = yield* sql<{ readonly space_id: string }>`
        SELECT space_id FROM spaces
        WHERE name_key = ${nameKey}
          AND space_id != ${validSpaceId}
          AND archived_at IS NULL
        LIMIT 1
      `
          if (duplicate.length > 0) {
            return yield* storeError(
              "update",
              "conflict",
              "An active Space already has that name. Pick another.",
              validSpaceId
            )
          }
          const instructions = Object.hasOwn(valid, "instructions")
            ? optionalText(valid.instructions)
            : current.instructions
          const instructionsSource = Object.hasOwn(valid, "instructions")
            ? "manual"
            : current.instructions_source
          const mark = Object.hasOwn(valid, "mark") ? (valid.mark ?? null) : current.mark
          const updated = yield* sql<SpaceRow>`
        UPDATE spaces
        SET name = ${name}, name_key = ${nameKey},
            instructions = ${instructions}, instructions_source = ${instructionsSource},
            mark = ${mark === null ? null : JSON.stringify(mark)},
            updated_at = ${updatedAt}
        WHERE space_id = ${validSpaceId} AND archived_at IS NULL
        RETURNING space_id, name, instructions, instructions_source, page_path, page_id,
                  inference_policy, mark, created_at, updated_at, archived_at
      `
          const next = updated[0]
          if (next === undefined) return null
          if (current.name !== name)
            yield* renameOwnedJob(sql, spaceJobId(validSpaceId), `${name} worker`)
          const shouldWake = current.inference.enabled && valid.instructions !== undefined
          if (shouldWake) yield* spaceJobs.queueSpaceWake(validSpaceId, now)
          else yield* spaceJobs.syncSpace(validSpaceId, now)
          const generations = yield* sql<{ readonly policy_generation: number }>`
        SELECT policy_generation FROM spaces WHERE space_id = ${validSpaceId}`
          if (generations[0]?.policy_generation !== row.policy_generation) {
          }
          yield* recordVersions
          return yield* decodeRow(next, "update")
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SpaceStoreError
            ? cause
            : storeError("update", "storage", "Could not update Space", validSpaceId, cause)
        )
      )
  })

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
        RETURNING space_id, name, instructions, instructions_source, page_path, page_id,
                  inference_policy, mark, created_at, updated_at, archived_at
      `
            const next = updated[0]
            return next === undefined ? yield* get(validSpaceId) : yield* decodeRow(next, "update")
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

  const bindPage = Effect.fn("SqliteSpaceStore.bindPage")(function* (
    spaceId: string,
    pageId: string,
    pagePath: string
  ): Effect.fn.Return<PersistedSpace | null, SpaceStoreError> {
    if (canonicalWikiPath(pagePath) === undefined) {
      return yield* storeError("page", "invalid", "That Memory page path is not valid.", spaceId)
    }
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const current = yield* get(spaceId)
          if (current === null) return null
          if (current.page_id !== null || current.page_path !== null) {
            return yield* storeError("page", "conflict", "Space already has a Memory page", spaceId)
          }
          const duplicate = yield* sql<{ readonly space_id: string }>`
        SELECT space_id FROM spaces
        WHERE (page_id = ${pageId} OR page_path = ${pagePath})
          AND space_id != ${spaceId}
        LIMIT 1
      `
          if (duplicate.length > 0) {
            return yield* storeError(
              "page",
              "conflict",
              "That Memory page belongs to another Space",
              spaceId
            )
          }
          const activeBindings = yield* sql<{
            readonly space_id: string
            readonly page_path: string
          }>`
        SELECT space_id, page_path
        FROM spaces
        WHERE space_id != ${spaceId}
          AND archived_at IS NULL
          AND page_path IS NOT NULL
      `
          if (
            activeBindings.some(
              (binding) =>
                canonicalWikiPath(binding.page_path) === undefined ||
                wikiSpaceBoundariesOverlap(pagePath, binding.page_path)
            )
          ) {
            return yield* storeError(
              "page",
              "conflict",
              "That Memory page overlaps another Space’s page.",
              spaceId
            )
          }
          const rows = yield* sql<SpaceRow>`
        UPDATE spaces
        SET page_id = ${pageId}, page_path = ${pagePath}, updated_at = ${now}
        WHERE space_id = ${spaceId} AND archived_at IS NULL
        RETURNING space_id, name, instructions, instructions_source, page_path, page_id,
                  inference_policy, mark, created_at, updated_at, archived_at
      `
          if (current.inference.enabled) yield* spaceJobs.queueSpaceWake(spaceId, now)
          else yield* spaceJobs.syncSpace(spaceId, now)
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

  const detachPage = Effect.fn("SqliteSpaceStore.detachPage")(function* (
    spaceId: string
  ): Effect.fn.Return<PersistedSpace | null, SpaceStoreError> {
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const current = yield* get(spaceId)
          if (current === null) return null
          const rows = yield* sql<SpaceRow>`
        UPDATE spaces
        SET page_id = NULL, page_path = NULL, updated_at = ${now}
        WHERE space_id = ${spaceId} AND archived_at IS NULL
        RETURNING space_id, name, instructions, instructions_source, page_path, page_id,
                  inference_policy, mark, created_at, updated_at, archived_at
      `
          yield* spaceJobs.syncSpace(spaceId, now)
          return rows[0] === undefined ? null : yield* decodeRow(rows[0], "page")
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SpaceStoreError
            ? cause
            : storeError("page", "storage", "Could not detach Space page", spaceId, cause)
        )
      )
  })

  const archive = Effect.fn("SqliteSpaceStore.archive")(function* (
    spaceId: string,
    mutation?: MutationOperationIdentity
  ): Effect.fn.Return<SpaceArchiveResponse | null, SpaceStoreError> {
    const validSpaceId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(spaceId).pipe(
      Effect.mapError((cause) =>
        storeError("archive", "invalid", "Space id must not be empty", undefined, cause)
      )
    )
    const timestamp = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "space",
            id: validSpaceId,
            identity: mutation
          })
          const active = yield* sql<{ readonly space_id: string }>`
        SELECT space_id FROM spaces
        WHERE space_id = ${validSpaceId} AND archived_at IS NULL
        LIMIT 1
      `.pipe(
            Effect.mapError((cause) =>
              storeError("archive", "storage", "Could not read Space", validSpaceId, cause)
            )
          )
          if (active[0] === undefined) return null
          const others = yield* sql`SELECT 1 FROM spaces
            WHERE space_id <> ${validSpaceId} AND archived_at IS NULL LIMIT 1`.pipe(
            Effect.mapError((cause) =>
              storeError("archive", "storage", "Could not read Spaces", validSpaceId, cause)
            )
          )
          if (others.length === 0) {
            return yield* storeError("archive", "conflict", KEEP_ONE_SPACE, validSpaceId)
          }
          const busy = yield* sql`SELECT 1 FROM sessions AS s
            WHERE s.space_id = ${validSpaceId} AND s.archived_at IS NULL
              AND ${chatHasActiveWork(sql, sql`s`)} LIMIT 1`
          if (busy.length > 0) {
            return yield* storeError(
              "archive",
              "conflict",
              "A chat on this Space has work running",
              validSpaceId
            )
          }
          yield* sql`
        UPDATE spaces
        SET archived_at = ${timestamp}, updated_at = ${timestamp}, pinned_position = NULL
        WHERE space_id = ${validSpaceId} AND archived_at IS NULL
      `.pipe(
            Effect.mapError((cause) =>
              storeError("archive", "storage", "Could not archive Space", validSpaceId, cause)
            )
          )
          yield* spaceJobs.syncSpace(validSpaceId, timestamp)
          yield* pauseForArchivedSpace({ sql, sessionEvents, spaceId: validSpaceId, mutation })
          yield* archiveSpaceChats(sql, validSpaceId, timestamp)
          const response = yield* Schema.decodeUnknownEffect(SpaceArchiveResponseSchema)({
            status: "archived",
            space_id: validSpaceId
          }).pipe(
            Effect.mapError((cause) =>
              storeError(
                "archive",
                "storage",
                "Space archive response is corrupt",
                validSpaceId,
                cause
              )
            )
          )
          yield* recordVersions
          return response
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SpaceStoreError
            ? cause
            : storeError(
                "archive",
                "storage",
                "Could not complete Space archive",
                validSpaceId,
                cause
              )
        )
      )
  })

  const restore = Effect.fn("SqliteSpaceStore.restore")(function* (
    spaceId: string
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
               inference_policy, mark, created_at, updated_at, archived_at
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
          if (row.page_path !== null) {
            const pagePath = row.page_path
            if (canonicalWikiPath(pagePath) === undefined) {
              return yield* storeError(
                "restore",
                "conflict",
                "This Space’s Memory page can no longer be used, so it cannot be restored.",
                validSpaceId
              )
            }
            const activeBindings = yield* sql<{
              readonly space_id: string
              readonly page_path: string
            }>`
          SELECT space_id, page_path
          FROM spaces
          WHERE space_id != ${validSpaceId}
            AND archived_at IS NULL
            AND page_path IS NOT NULL
        `
            if (
              activeBindings.some(
                (binding) =>
                  canonicalWikiPath(binding.page_path) === undefined ||
                  wikiSpaceBoundariesOverlap(pagePath, binding.page_path)
              )
            ) {
              return yield* storeError(
                "restore",
                "conflict",
                "That Memory page overlaps another Space’s page.",
                validSpaceId
              )
            }
          }
          const restored = yield* sql<SpaceRow>`
        UPDATE spaces
        SET archived_at = NULL, updated_at = ${now}
        WHERE space_id = ${validSpaceId} AND archived_at IS NOT NULL
        RETURNING space_id, name, instructions, instructions_source, page_path, page_id,
                  inference_policy, mark, created_at, updated_at, archived_at
      `
          const next = restored[0]
          if (next === undefined) return null
          yield* restoreSpaceChats(sql, validSpaceId)
          const state = yield* spaceJobs.syncSpace(validSpaceId, now)
          if (state?.enabled === true) yield* spaceJobs.queueSpaceWake(validSpaceId, now)
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
    detachPage,
    archive,
    restore,
    detail,
    recordLetterSubject,
    linkChat,
    unlinkedSpaces,
    overview,
    setPinned,
    hasPageBinding,
    ownsWikiPath
  })
}
