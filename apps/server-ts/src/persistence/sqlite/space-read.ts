import { countsAsRun } from "./automation-skip-record.js"
import type { SpaceAgentAvailability, SpaceDetail, SpacesOverview } from "@arden-hq/protocol/spaces"
import { SpaceDetailSchema, SpacesOverviewSchema } from "@arden-hq/protocol/effect/spaces"
import { EvidenceSourceRefSchema } from "@arden-hq/protocol/effect/spaces/work"
import { Clock, DateTime, Effect, Schema } from "effect"
import { SpaceStoreError, type SpaceStore } from "../spaces/store.js"
import { previewLine } from "../transcript/preview-line.js"
import { decodeRow, storeError, type SpaceRow } from "./space-row.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"
import { readTaskResults } from "./work-results.js"
import { readWorkState, workActivitySql } from "./work-activity.js"
import { decodeWorkItem, workItemColumns, type WorkItemRow } from "./work-items.js"
import { makeWorkSourceSql } from "./work-sources.js"
import { inArdenWords } from "../restart-notice.js"
import { iso } from "../../runtime/clock.js"
import { spaceOverviewInput } from "./space-overview-input.js"
import { overviewSourceFreshness } from "../summaries/freshness.js"
import { taskOpenSql } from "./task-status-sql.js"

interface OverviewSpaceRow extends SpaceRow {
  readonly running_since: string | null
  readonly pinned_position: number | null
  readonly last_text: string | null
}

interface UnreadSpaceMessageRow {
  readonly space_id: string
  readonly session_id: string
  readonly created_at: string
  readonly search_text: string | null
  readonly subject: string | null
}

interface CompletedBriefRow {
  readonly event_id: number
  readonly space_id: string
  readonly stable_key: string
  readonly text: string
  readonly completed_at: string
  readonly updated_at: string
}

interface ActiveBriefRow {
  readonly space_id: string
  readonly stable_key: string
  readonly text: string
  readonly status: string
  readonly owner: string
  readonly completed_at: string | null
  readonly updated_at: string
}

interface SessionDetailRow {
  readonly session_id: string
  readonly public_ref: string
  readonly name: string | null
  readonly last_text: string | null
  readonly last_activity: string
  readonly summary: string | null
}

interface SpaceWorkerRow {
  readonly task_id: string
  readonly last_result: string | null
  readonly running_since: string | null
  readonly latest_chat_run_id: string | null
  readonly latest_status: string | null
  readonly latest_error: string | null
}

interface WorkEventDetailRow {
  readonly event_id: number
  readonly space_id: string
  readonly item_id: string | null
  readonly run_ref: string | null
  readonly event_type: string
  readonly summary: string
  readonly content_kind: string
  readonly source_refs: string
  readonly created_at: string
}

const WORKER_STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1_000

const workerAvailability = (
  worker: SpaceWorkerRow | undefined,
  liveTasks: number,
  lastRunAt: string | null,
  nowMs: number
): SpaceAgentAvailability => {
  if (worker === undefined) return "unavailable"
  if (worker.latest_status === "failed") return "error"
  if (liveTasks === 0) return "ready"
  const lastRunMs = lastRunAt === null ? Number.NaN : Date.parse(lastRunAt)
  return Number.isNaN(lastRunMs) || nowMs - lastRunMs > WORKER_STALE_AFTER_MS ? "stale" : "ready"
}

interface WorkCommentDetailRow {
  readonly comment_id: number
  readonly space_id: string
  readonly item_id: string
  readonly author: string
  readonly body: string
  readonly created_at: string
  readonly kind: string
}

interface WorkAttachmentDetailRow {
  readonly attachment_id: number
  readonly space_id: string
  readonly item_id: string
  readonly name: string
  readonly media_type: string
  readonly size: number
  readonly created_by: string
  readonly created_at: string
}

const evidenceSourceRefsSchema = Schema.Array(EvidenceSourceRefSchema)

export const makeSpaceReads = (
  reader: PersistenceDeps["reader"]
): Pick<SpaceStore["Service"], "overview" | "detail"> => {
  const overview = Effect.fn("SqliteSpaceStore.overview")(function* (): Effect.fn.Return<
    SpacesOverview,
    SpaceStoreError
  > {
    const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 72 }))

    return yield* Effect.gen(function* () {
      const spaces = yield* reader<OverviewSpaceRow>`
        SELECT d.space_id, d.name, d.instructions, d.instructions_source, d.page_path, d.page_id,
               d.inference_policy, d.mark, d.created_at, d.updated_at, d.archived_at,
               worker.running_since, d.pinned_position,
               (SELECT m.search_text FROM session_messages AS m
                WHERE m.session_id = latest.session_id AND m.role = 'assistant'
                  AND TRIM(COALESCE(m.search_text, '')) <> ''
                ORDER BY m.seq DESC LIMIT 1) AS last_text
        FROM spaces AS d
        LEFT JOIN scheduled_tasks AS worker ON worker.purpose = 'space_review' AND worker.owner_space_id = d.space_id
        LEFT JOIN sessions AS latest ON latest.session_id = (
          SELECT s.session_id FROM sessions AS s
          WHERE s.space_id = d.space_id AND s.archived_at IS NULL
            AND s.session_type = 'chat' AND s.parent_session_id IS NULL
            AND s.parent_message_id IS NULL
            AND EXISTS (
              SELECT 1 FROM session_messages AS m
              WHERE m.session_id = s.session_id AND m.role = 'assistant'
                AND TRIM(COALESCE(m.search_text, '')) <> ''
            )
          ORDER BY s.last_activity DESC, s.session_id DESC LIMIT 1
        )
        WHERE d.archived_at IS NULL
        -- The Spaces the owner placed first, in their order; then the rest by
        -- their latest chat, a Space with no chat yet by when it was made.
        ORDER BY d.pinned_position IS NULL, d.pinned_position,
                 COALESCE(
                   (SELECT MAX(s.last_activity) FROM sessions AS s
                     WHERE s.space_id = d.space_id AND s.archived_at IS NULL
                       AND s.session_type = 'chat' AND s.parent_session_id IS NULL),
                   d.created_at
                 ) DESC,
                 d.space_id DESC
      `.pipe(
        Effect.mapError((cause) =>
          storeError("overview", "storage", "Could not load Space overview", undefined, cause)
        )
      )

      const unreadRows = yield* reader<UnreadSpaceMessageRow>`
        WITH ranked AS (
          SELECT s.space_id, m.session_id, m.created_at, m.search_text, ls.subject,
                 ROW_NUMBER() OVER (
                   PARTITION BY s.space_id
                   ORDER BY m.created_at DESC, m.seq DESC, m.message_id DESC
                 ) AS rank
          FROM sessions AS s
          JOIN spaces AS active_space
            ON active_space.space_id = s.space_id
           AND active_space.archived_at IS NULL
          JOIN session_messages AS m ON m.session_id = s.session_id
          LEFT JOIN letter_subjects AS ls
            ON ls.session_id = m.session_id AND ls.message_id = m.message_id
          WHERE s.archived_at IS NULL
            AND s.session_type = 'chat'
            AND s.parent_session_id IS NULL
            AND s.parent_message_id IS NULL
            AND s.has_unread = 1
            AND m.role = 'assistant'
        )
        SELECT space_id, session_id, created_at, search_text, subject
        FROM ranked
        WHERE rank = 1
        ORDER BY created_at DESC, session_id DESC
      `.pipe(
        Effect.mapError((cause) =>
          storeError(
            "overview",
            "storage",
            "Could not load Space unread messages",
            undefined,
            cause
          )
        )
      )

      const completedRows = yield* reader<CompletedBriefRow>`
        SELECT events.event_id, events.space_id,
               COALESCE(items.stable_key, 'event-' || events.event_id) AS stable_key,
               events.summary AS text,
               events.created_at AS completed_at,
               events.created_at AS updated_at
        FROM space_task_events AS events
        LEFT JOIN space_tasks AS items ON items.item_id = events.item_id
        WHERE events.event_type IN ('done', 'completed')
          AND events.created_at >= ${cutoff}
          AND EXISTS (
            SELECT 1 FROM spaces AS active_space
            WHERE active_space.space_id = events.space_id
              AND active_space.archived_at IS NULL
          )
        ORDER BY events.created_at DESC, events.event_id DESC
        LIMIT 6
      `.pipe(
        Effect.mapError((cause) =>
          storeError("overview", "storage", "Could not load Space completed work", undefined, cause)
        )
      )

      const activeRows = yield* reader<ActiveBriefRow>`
        WITH ranked AS (
          SELECT wi.space_id, wi.stable_key, wi.text, wi.status, wi.owner,
                 wi.completed_at, wi.updated_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY wi.space_id
                   ORDER BY
                            CASE wi.owner WHEN 'worker' THEN 0 ELSE 1 END,
                            wi.updated_at DESC,
                            wi.item_id DESC
                 ) AS rank
          FROM space_tasks AS wi
          JOIN spaces AS active_space ON active_space.space_id = wi.space_id
          WHERE active_space.archived_at IS NULL
            AND ${taskOpenSql("wi")}
            AND ${workActivitySql(reader, reader`wi`)} = 'working'
        )
        SELECT space_id, stable_key, text, status, owner, completed_at, updated_at
        FROM ranked
        WHERE rank = 1
        ORDER BY updated_at DESC
        LIMIT 6
      `.pipe(
        Effect.mapError((cause) =>
          storeError("overview", "storage", "Could not load Space active work", undefined, cause)
        )
      )

      const titles = new Map(spaces.map((row) => [row.space_id, row.name]))
      const unreadBySpace = new Map(
        unreadRows.map((row) => [
          row.space_id,
          {
            at: row.created_at,
            session_id: row.session_id,
            line: previewLine(row.search_text) ?? "",
            subject: row.subject
          }
        ])
      )
      const spaceValues = yield* Effect.forEach(
        spaces,
        Effect.fn("SqliteSpaceStore.spaceValues.row")(function* (row) {
          const space = yield* decodeRow(row, "overview")
          return {
            key: space.space_id,
            title: space.name,
            page_path: space.page_path,
            live: row.running_since !== null,
            pinned: row.pinned_position !== null,
            mark: space.mark,
            updated_at: space.updated_at,
            unseen: unreadBySpace.get(space.space_id) ?? null,
            last_line: previewLine(row.last_text)
          }
        })
      )

      return yield* Schema.decodeUnknownEffect(SpacesOverviewSchema)({
        spaces: spaceValues,
        unseen: unreadRows.map((row) => ({
          space_id: row.space_id,
          space_title: titles.get(row.space_id) ?? row.space_id,
          at: row.created_at,
          session_id: row.session_id,
          line: previewLine(row.search_text) ?? "",
          subject: row.subject
        })),
        brief: {
          done: completedRows.map((row) => ({
            space_id: row.space_id,
            space_title: titles.get(row.space_id) ?? row.space_id,
            stable_key: row.stable_key,
            text: row.text,
            completed_at: row.completed_at,
            updated_at: row.updated_at
          })),
          in_progress: activeRows.map((row) => ({
            space_id: row.space_id,
            space_title: titles.get(row.space_id) ?? row.space_id,
            stable_key: row.stable_key,
            text: row.text,
            status: row.status,
            owner: row.owner,
            completed_at: row.completed_at,
            updated_at: row.updated_at
          }))
        }
      }).pipe(
        Effect.mapError((cause) =>
          storeError("overview", "storage", "Stored Space overview is corrupt", undefined, cause)
        )
      )
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SpaceStoreError
          ? cause
          : storeError("overview", "storage", "Could not complete Space overview", undefined, cause)
      )
    )
  })

  const detail = Effect.fn("SqliteSpaceStore.detail")(function* (
    spaceId: string
  ): Effect.fn.Return<SpaceDetail | null, SpaceStoreError> {
    const validSpaceId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(spaceId).pipe(
      Effect.mapError((cause) =>
        storeError("detail", "invalid", "Space id must not be empty", undefined, cause)
      )
    )
    const workerAutomationId = `space:${validSpaceId}`

    return yield* Effect.gen(function* () {
      const spaces = yield* reader<SpaceRow>`
        SELECT space_id, name, instructions, instructions_source, page_path, page_id,
               inference_policy, mark, created_at, updated_at, archived_at
        FROM spaces
        WHERE space_id = ${validSpaceId} AND archived_at IS NULL
        LIMIT 1
      `.pipe(
        Effect.mapError((cause) =>
          storeError("detail", "storage", "Could not load Space", validSpaceId, cause)
        )
      )
      const spaceRow = spaces[0]
      if (spaceRow === undefined) return null
      const space = yield* decodeRow(spaceRow, "detail")

      const conversation = yield* reader<{ readonly session_id: string }>`
        SELECT session_id FROM space_conversations WHERE space_id = ${validSpaceId}
      `
      const sessionRows = yield* reader<SessionDetailRow>`
        SELECT s.session_id, s.public_ref, s.name, s.last_activity,
          (SELECT m.search_text FROM session_messages AS m
            WHERE m.session_id = s.session_id AND m.role = 'assistant'
            ORDER BY m.seq DESC LIMIT 1) AS last_text,
          (SELECT summary FROM chat_summaries WHERE session_id = s.session_id) AS summary
        FROM sessions AS s
        WHERE s.space_id = ${validSpaceId}
          AND s.archived_at IS NULL
          AND s.session_type = 'chat'
          AND s.parent_session_id IS NULL
          AND s.parent_message_id IS NULL
        ORDER BY s.last_activity DESC, s.session_id DESC
      `.pipe(
        Effect.mapError((cause) =>
          storeError("detail", "storage", "Could not load Space sessions", validSpaceId, cause)
        )
      )
      const sessions = sessionRows.map((row) => ({
        session_id: row.session_id,
        session_ref: row.public_ref,
        name: row.name,
        last_line: previewLine(row.last_text),
        last_activity: row.last_activity,
        summary: row.summary
      }))
      const { overview, overviewSource } = yield* reader
        .withTransaction(
          Effect.gen(function* () {
            const overviews = yield* reader<{
              readonly now: string
              readonly next_json: string
              readonly updated_at: string
              readonly revision_id: number | null
              readonly sources_fingerprint: string
            }>`SELECT now, next_json, updated_at, revision_id, sources_fingerprint
            FROM space_summaries WHERE space_id = ${validSpaceId}`
            const overview = overviews[0]
            const overviewSource =
              overview === undefined ? null : yield* spaceOverviewInput(reader, validSpaceId)
            return { overview, overviewSource }
          })
        )
        .pipe(
          Effect.mapError((cause) =>
            storeError(
              "detail",
              "storage",
              "Could not load the Space overview",
              validSpaceId,
              cause
            )
          )
        )

      const workers = yield* reader<SpaceWorkerRow>`
        SELECT task.task_id, task.last_result, task.running_since,
               latest.chat_run_id AS latest_chat_run_id,
               latest.status AS latest_status, latest.error AS latest_error
        FROM scheduled_tasks AS task
        LEFT JOIN automation_runs AS latest
          ON latest.id = (
            SELECT candidate.id
            FROM automation_runs AS candidate
            WHERE candidate.task_id = task.task_id AND ${countsAsRun(reader, reader`candidate`)}
            ORDER BY candidate.id DESC
            LIMIT 1
          )
        WHERE task.task_id = ${workerAutomationId}
          AND task.owner_space_id = ${validSpaceId}
          AND task.purpose = 'space_review'
        LIMIT 1
      `.pipe(
        Effect.mapError((cause) =>
          storeError("detail", "storage", "Could not load Space worker", validSpaceId, cause)
        )
      )
      const pendingWorkerWake = yield* reader<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM automation_event_queue
        WHERE task_id = ${workerAutomationId} AND claimed_at IS NULL
      `
      const runsToday = yield* reader<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM automation_runs
        WHERE task_id = ${workerAutomationId} AND ${countsAsRun(reader, reader`automation_runs`)}
          AND date(started_at) = date(${iso(yield* Clock.currentTimeMillis)})
      `

      const workItems = yield* reader<WorkItemRow>`
        SELECT ${workItemColumns(reader)}
        FROM space_tasks
        WHERE space_id = ${validSpaceId}
        ORDER BY CASE status
          WHEN 'open' THEN 0
          WHEN 'deferred' THEN 1
          ELSE 2
        END, updated_at DESC, item_id DESC
      `.pipe(
        Effect.mapError((cause) =>
          storeError("detail", "storage", "Could not load Space work items", validSpaceId, cause)
        )
      )

      const workEvents = yield* reader<WorkEventDetailRow>`
        SELECT event_id, space_id, item_id, run_ref, event_type, summary, content_kind, source_refs, created_at
        FROM space_task_events
        WHERE space_id = ${validSpaceId}
        ORDER BY created_at DESC, event_id DESC
        LIMIT 50
      `.pipe(
        Effect.mapError((cause) =>
          storeError("detail", "storage", "Could not load Space work events", validSpaceId, cause)
        )
      )

      const workComments = yield* reader<WorkCommentDetailRow>`
        SELECT comment_id, space_id, item_id, author, body, created_at, kind
        FROM (
          SELECT comment_id, space_id, item_id, author, body, created_at, kind,
                 ROW_NUMBER() OVER (
                   PARTITION BY item_id
                   ORDER BY created_at DESC, comment_id DESC
                 ) AS recency
          FROM space_task_comments
          WHERE space_id = ${validSpaceId}
        )
        WHERE recency <= 5
        ORDER BY created_at DESC, comment_id DESC
      `.pipe(
        Effect.mapError((cause) =>
          storeError("detail", "storage", "Could not load Space work comments", validSpaceId, cause)
        )
      )

      const workAttachments = yield* reader<WorkAttachmentDetailRow>`
        SELECT attachment.attachment_id, attachment.space_id, attachment.item_id,
               attachment.name, attachment.media_type, attachment.size,
               attachment.created_by, attachment.created_at
        FROM space_task_attachments AS attachment
        JOIN space_tasks AS item
          ON item.item_id = attachment.item_id
         AND item.space_id = attachment.space_id
        WHERE attachment.space_id = ${validSpaceId}
        ORDER BY attachment.created_at DESC, attachment.attachment_id DESC
      `.pipe(
        Effect.mapError((cause) =>
          storeError(
            "detail",
            "storage",
            "Could not load Space work attachments",
            validSpaceId,
            cause
          )
        )
      )

      const activity = yield* readWorkState(
        reader,
        workItems.map((row) => row.item_id)
      ).pipe(
        Effect.mapError((cause) =>
          storeError("detail", "storage", cause.message, validSpaceId, cause)
        )
      )
      const sourceMap = yield* makeWorkSourceSql(reader)
        .read(workItems.map((row) => row.item_id))
        .pipe(
          Effect.mapError((cause) =>
            storeError("detail", "storage", "Could not load Task sources", validSpaceId, cause)
          )
        )
      const items = yield* Effect.forEach(workItems, (row) =>
        decodeWorkItem(row, sourceMap.get(row.item_id) ?? [], activity.get(row.item_id)).pipe(
          Effect.mapError((cause) =>
            storeError("detail", "storage", "Stored Task is corrupt", validSpaceId, cause)
          )
        )
      )
      const events = yield* Effect.forEach(workEvents, (row) =>
        decodeJson(evidenceSourceRefsSchema, row.source_refs).pipe(
          Effect.mapError((cause) =>
            storeError(
              "detail",
              "storage",
              "Space work event source_refs are corrupt",
              validSpaceId,
              cause
            )
          ),
          Effect.map((source_refs) => {
            const { summary, content_kind, ...event } = row
            return { ...event, source_refs, content: { kind: content_kind, text: summary } }
          })
        )
      )
      const worker = workers[0]
      const workerLatestFailed = worker?.latest_status === "failed"
      const liveTasks = workItems.filter((item) => item.status === "open").length
      const spaceRuns = yield* reader<{ readonly last_run_at: string | null }>`
        SELECT MAX(last_run_at) AS last_run_at
        FROM scheduled_tasks
        WHERE owner_space_id = ${space.space_id} AND purpose IN ('space_review', 'task_execution')
      `
      const lastRunAt = spaceRuns[0]?.last_run_at ?? null
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
      const detailValue = yield* Schema.decodeUnknownEffect(SpaceDetailSchema)({
        conversation_session_id: conversation[0]?.session_id ?? null,
        inference: space.inference,
        key: space.space_id,
        title: space.name,
        page_path: space.page_path,
        instructions: space.instructions,
        agent: !space.inference.enabled
          ? null
          : {
              latest_run_id: worker?.latest_chat_run_id ?? null,
              last_checked: lastRunAt,
              next_check: null,
              last_report: inArdenWords(worker?.last_result ?? null),
              woken_by: (pendingWorkerWake[0]?.count ?? 0) > 0 ? ["work updated"] : [],
              runs_today: runsToday[0]?.count ?? 0,
              runs_cap: 100,
              running_since: worker?.running_since ?? null,
              availability: workerAvailability(worker, liveTasks, lastRunAt, nowMs),
              last_error: workerLatestFailed ? (worker?.latest_error ?? "Space run failed") : null
            },
        sessions,
        overview:
          overview === undefined
            ? null
            : {
                now: overview.now,
                next: JSON.parse(overview.next_json),
                updated_at: overview.updated_at,
                revision_id: overview.revision_id,
                source_freshness: overviewSourceFreshness(
                  overview.revision_id,
                  overview.sources_fingerprint,
                  overviewSource?.fingerprint ?? null
                )
              },
        work: {
          results: yield* readTaskResults(
            reader,
            workItems.map((item) => item.item_id)
          ).pipe(
            Effect.mapError((cause) =>
              storeError("detail", "storage", cause.message, validSpaceId, cause)
            )
          ),
          work_items: items,
          events,
          comments: workComments,
          attachments: workAttachments
        }
      }).pipe(
        Effect.mapError((cause) =>
          storeError("detail", "storage", "Stored Space detail is corrupt", validSpaceId, cause)
        )
      )
      return detailValue
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SpaceStoreError
          ? cause
          : storeError("detail", "storage", "Could not complete Space detail", validSpaceId, cause)
      )
    )
  })

  return { overview, detail }
}

export const makeSpaceLists = (
  sql: PersistenceDeps["writer"]["sql"]
): Pick<SpaceStore["Service"], "list" | "listArchived"> => {
  const list = Effect.fn("SqliteSpaceStore.list")(function* () {
    const rows = yield* sql<SpaceRow>`
      SELECT space_id, name, instructions, instructions_source, page_path, page_id,
             inference_policy, mark, created_at, updated_at, archived_at
      FROM spaces
      WHERE archived_at IS NULL
      ORDER BY updated_at DESC, created_at DESC, space_id DESC
    `.pipe(
      Effect.mapError((cause) =>
        storeError("list", "storage", "Could not list Spaces", undefined, cause)
      )
    )
    return yield* Effect.forEach(rows, (row) => decodeRow(row, "list"))
  })

  const listArchived = Effect.fn("SqliteSpaceStore.listArchived")(function* () {
    const rows = yield* sql<SpaceRow>`
      SELECT space_id, name, instructions, instructions_source, page_path, page_id,
             inference_policy, mark, created_at, updated_at, archived_at
      FROM spaces
      WHERE archived_at IS NOT NULL
      ORDER BY archived_at DESC, created_at DESC, space_id DESC
    `.pipe(
      Effect.mapError((cause) =>
        storeError("list", "storage", "Could not list archived Spaces", undefined, cause)
      )
    )
    return yield* Effect.forEach(rows, (row) => decodeRow(row, "list"))
  })

  return { list, listArchived }
}
