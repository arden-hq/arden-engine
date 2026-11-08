import { countsAsRun } from "./automation-skip-record.js"
import { readTaskApprovals } from "./work-approvals.js"
import { readWorkState } from "./work-activity.js"
import { readTaskResults } from "./work-results.js"
import type { SpaceWorkPage, SpaceWorkPageOptions } from "@arden-hq/protocol/spaces/work"
import { WORK_PAGE_DEFAULT_LIMIT } from "@arden-hq/protocol/spaces/work"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import { SpaceWorkPageSchema } from "@arden-hq/protocol/effect/spaces/work"
import { Effect, Option, Schema } from "effect"
import type { PersistenceDeps } from "./deps.js"
import { WorkStoreError } from "../work/store.js"
import {
  decodeWorkItem as decodeWorkItemWithSources,
  workItemColumns,
  type WorkItemRow
} from "./work-items.js"
import { makeWorkSourceSql } from "./work-sources.js"
import {
  decodeWorkAttachment,
  decodeWorkComment,
  decodeWorkEvent,
  workError,
  type WorkAttachmentRow,
  type WorkCommentRow,
  type WorkEventRow
} from "./work-records.js"
import { inArdenWords } from "../restart-notice.js"
import { decodeOpaque, encodeOpaque } from "../../lib/opaque-ref.js"

interface WorkRunRow {
  readonly attempt_count: number
  readonly item_id: string
  readonly session_id: string
  readonly run_id: number
  readonly chat_run_id: string | null
  readonly started_at: string | null
  readonly ended_at: string | null
  readonly status: string | null
  readonly chat_status: string | null
  readonly chat_ended_at: string | null
  readonly result: string | null
  readonly error: string | null
}

interface WorkCursor {
  readonly updatedAt: string
  readonly itemId: string
}

const WorkCursorSchema = Schema.Struct({
  updatedAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  itemId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
})

const WORK_PAGE_EVENT_WINDOW = 12

const encodeWorkCursor = (row: WorkItemRow): string =>
  encodeOpaque({
    updatedAt: row.updated_at,
    itemId: row.item_id
  } satisfies WorkCursor)

const decodeWorkCursor = Effect.fn("SqliteWorkStore.decodeWorkCursor")(function* (
  value: string | undefined
): Effect.fn.Return<WorkCursor | null, WorkStoreError> {
  if (value === undefined) return null
  const decoded = decodeOpaque(WorkCursorSchema, value)
  if (Option.isNone(decoded)) return yield* workError("invalid", "Invalid Work page cursor")
  return decoded.value
})

export const makeWorkPage = ({ writer, reader }: Pick<PersistenceDeps, "writer" | "reader">) => {
  const sql = reader
  const sources = makeWorkSourceSql(sql)
  return Effect.fn("SqliteWorkStore.page")(function* (
    options: SpaceWorkPageOptions
  ): Effect.fn.Return<SpaceWorkPage, WorkStoreError> {
    const limit = options.limit ?? WORK_PAGE_DEFAULT_LIMIT
    const cursor = yield* decodeWorkCursor(options.cursor)
    return yield* writer
      .snapshot(
        Effect.gen(function* () {
          const clauses = [sql`(item.space_id IS NULL OR space.archived_at IS NULL)`]
          if (options.itemId) clauses.push(sql`item.item_id = ${options.itemId}`)
          if (options.spaceId) clauses.push(sql`item.space_id = ${options.spaceId}`)
          if (options.sessionId) clauses.push(sql`item.home_session_id = ${options.sessionId}`)
          if (options.turnId)
            clauses.push(sql`(
        SELECT json_extract(source.source, '$.turn_id') FROM space_task_sources AS source
        WHERE source.item_id = item.item_id AND json_extract(source.source, '$.kind') = 'chat'
          AND json_extract(source.source, '$.session_id') = ${options.sessionId}
        ORDER BY source.created_at, source.source_key LIMIT 1
      ) = ${options.turnId}`)
          if (cursor !== null) {
            clauses.push(sql`(
          item.updated_at < ${cursor.updatedAt}
          OR (item.updated_at = ${cursor.updatedAt} AND item.item_id < ${cursor.itemId})
        )`)
          }
          const pageRows = yield* sql<WorkItemRow>`
        SELECT ${workItemColumns(sql, "item")}
        FROM space_tasks AS item
        LEFT JOIN spaces AS space ON space.space_id = item.space_id
        WHERE ${sql.and(clauses)}
        ORDER BY item.updated_at DESC, item.item_id DESC
        LIMIT ${limit + 1}
      `.pipe(
            Effect.mapError((cause) =>
              workError("storage", "Could not load Space work items", cause)
            )
          )

          const visibleRows = pageRows.slice(0, limit)
          const lastVisible = visibleRows.at(-1)
          const targetRows =
            options.targetItemId === undefined ||
            visibleRows.some((row) => row.item_id === options.targetItemId)
              ? []
              : yield* sql<WorkItemRow>`
          SELECT ${workItemColumns(sql, "item")}
          FROM space_tasks AS item
          LEFT JOIN spaces AS space ON space.space_id = item.space_id
          WHERE (item.space_id IS NULL OR space.archived_at IS NULL)
            AND item.item_id = ${options.targetItemId}
            AND (${options.spaceId ?? null} IS NULL OR item.space_id = ${options.spaceId ?? null})
            AND (${options.sessionId === undefined ? 1 : 0} = 1
              OR item.home_session_id = ${options.sessionId ?? null})
          LIMIT 1
        `.pipe(
                  Effect.mapError((cause) =>
                    workError("storage", "Could not load the targeted Space work item", cause)
                  )
                )
          const selectedRows = [...visibleRows, ...targetRows]
          const itemIds = selectedRows.map((row) => row.item_id)

          const commentRows =
            itemIds.length === 0
              ? []
              : yield* sql<WorkCommentRow>`
          SELECT comment_id, space_id, item_id, author, body, created_at, kind
          FROM space_task_comments
          WHERE item_id IN ${sql.in(itemIds)}
          ORDER BY created_at ASC, comment_id ASC
        `.pipe(
                  Effect.mapError((cause) =>
                    workError("storage", "Could not load Space work comments", cause)
                  )
                )

          const eventRows =
            itemIds.length === 0
              ? []
              : yield* sql<WorkEventRow>`
          SELECT event_id, space_id, item_id, run_ref, event_type, summary, content_kind,
                 source_refs, created_at
          FROM (
            SELECT event_id, space_id, item_id, run_ref, event_type, summary, content_kind,
                   source_refs, created_at,
                   ROW_NUMBER() OVER (
                     PARTITION BY item_id
                     ORDER BY created_at DESC, event_id DESC
                   ) AS recency
            FROM space_task_events
            WHERE item_id IN ${sql.in(itemIds)}
          )
          WHERE ${options.itemId ?? null} IS NOT NULL OR recency <= ${WORK_PAGE_EVENT_WINDOW}
          ORDER BY created_at ASC, event_id ASC
        `.pipe(
                  Effect.mapError((cause) =>
                    workError("storage", "Could not load Space work events", cause)
                  )
                )

          const attachmentRows =
            itemIds.length === 0
              ? []
              : yield* sql<WorkAttachmentRow>`
          SELECT attachment_id, space_id, item_id, name, media_type, size,
                 created_by, created_at
          FROM space_task_attachments
          WHERE item_id IN ${sql.in(itemIds)}
          ORDER BY created_at DESC, attachment_id DESC
        `.pipe(
                  Effect.mapError((cause) =>
                    workError("storage", "Could not load Space work attachments", cause)
                  )
                )

          const runRows =
            itemIds.length === 0
              ? []
              : yield* sql<WorkRunRow>`
          SELECT item.item_id, latest.chat_session_id AS session_id, latest.id AS run_id, latest.chat_run_id,
                 latest.started_at, latest.ended_at, latest.status,
                 chat.status AS chat_status, chat.ended_at AS chat_ended_at,
                 latest.result, latest.error,
                 (SELECT COUNT(*) FROM automation_runs AS attempt WHERE attempt.item_id = item.item_id
                   AND ${countsAsRun(sql, sql`attempt`)}) AS attempt_count
          FROM space_tasks AS item
          JOIN automation_runs AS latest
            ON latest.id = (
              SELECT run.id
              FROM automation_runs AS run
              WHERE run.item_id = item.item_id AND ${countsAsRun(sql, sql`run`)}
              ORDER BY run.id DESC
              LIMIT 1
            )
          LEFT JOIN chat_runs AS chat ON chat.run_id = latest.chat_run_id
          WHERE item.item_id IN ${sql.in(itemIds)}
            AND latest.chat_session_id IS NOT NULL AND latest.chat_run_id IS NOT NULL
          ORDER BY item.updated_at DESC, item.item_id DESC
        `.pipe(
                  Effect.mapError((cause) =>
                    workError("storage", "Could not load Space task runs", cause)
                  )
                )

          const activity = yield* readWorkState(sql, itemIds)
          const sourceMap = yield* sources.read(itemIds)
          const items = yield* Effect.forEach(selectedRows, (row) =>
            decodeWorkItemWithSources(
              row,
              sourceMap.get(row.item_id) ?? [],
              activity.get(row.item_id)
            )
          )
          const events = yield* Effect.forEach(eventRows, decodeWorkEvent)
          const comments = yield* Effect.forEach(commentRows, decodeWorkComment)
          const attachments = yield* Effect.forEach(attachmentRows, decodeWorkAttachment)
          const runs = runRows.map((row) => {
            const running = isActiveRunStatus(row.chat_status)
            return {
              attempt_count: row.attempt_count,
              item_id: row.item_id,
              session_id: row.session_id,
              running,
              run_id: row.run_id,
              chat_run_id: row.chat_run_id,
              started_at: row.started_at,
              ended_at: running ? null : (row.chat_ended_at ?? row.ended_at),
              result: inArdenWords(
                row.status === "failed" || row.status === "interrupted" ? row.error : row.result
              )
            }
          })

          return yield* Schema.decodeUnknownEffect(SpaceWorkPageSchema)({
            items,
            events,
            comments,
            attachments,
            runs,
            results: yield* readTaskResults(sql, itemIds),
            approvals: yield* readTaskApprovals(sql, itemIds),
            next_cursor:
              pageRows.length > limit && lastVisible !== undefined
                ? encodeWorkCursor(lastVisible)
                : null
          }).pipe(
            Effect.mapError((cause) => workError("storage", "Stored Space work is corrupt", cause))
          )
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkStoreError
            ? cause
            : workError("storage", "Could not complete Space work read", cause)
        )
      )
  })
}
