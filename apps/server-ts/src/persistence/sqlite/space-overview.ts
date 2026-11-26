import { ROLE } from "@arden-hq/std/message-vocabulary"
import { openRunSince } from "./automation-running.js"
import { SPACE_UNSEEN, type SpacesOverview } from "@arden-hq/protocol/spaces"
import { SpacesOverviewSchema } from "@arden-hq/protocol/effect/spaces"
import { DateTime, Effect, Schema } from "effect"
import { publicMark } from "../spaces/mark.js"
import { lastLine, letterSubject, publicPage } from "../spaces/public.js"
import { SpaceStoreError, type SpaceStore } from "../spaces/store.js"
import { previewLine } from "../transcript/preview-line.js"
import { decodeRow, storeError, type SpaceRow } from "./space-row.js"
import type { PersistenceDeps } from "./deps.js"
import { workActivitySql } from "./work-activity.js"
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
  readonly updated_at: string
}

export const makeSpaceOverview = (
  reader: PersistenceDeps["reader"]
): SpaceStore["Service"]["overview"] =>
  Effect.fn("SqliteSpaceStore.overview")(function* (): Effect.fn.Return<
    SpacesOverview,
    SpaceStoreError
  > {
    const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 72 }))

    return yield* Effect.gen(function* () {
      const spaces = yield* reader<OverviewSpaceRow>`
      SELECT d.space_id, d.name, d.instructions, d.instructions_source, d.page_path, d.page_id,
             d.inference_policy, d.mark, d.kind, d.created_at, d.updated_at, d.archived_at,
             ${openRunSince(reader, reader`'space:' || d.space_id`)} AS running_since, d.pinned_position,
             (SELECT m.search_text FROM session_messages AS m
              WHERE m.session_id = latest.session_id AND m.role = ${ROLE.assistant}
                AND TRIM(COALESCE(m.search_text, '')) <> ''
              ORDER BY m.seq DESC LIMIT 1) AS last_text
      FROM spaces AS d
      LEFT JOIN sessions AS latest ON latest.session_id = (
        SELECT s.session_id FROM sessions AS s
        WHERE s.space_id = d.space_id AND s.archived_at IS NULL
          AND s.session_type = 'chat' AND s.parent_session_id IS NULL
          AND s.parent_message_id IS NULL
          AND EXISTS (
            SELECT 1 FROM session_messages AS m
            WHERE m.session_id = s.session_id AND m.role = ${ROLE.assistant}
              AND TRIM(COALESCE(m.search_text, '')) <> ''
          )
        ORDER BY s.last_activity DESC, s.session_id DESC LIMIT 1
      )
      WHERE d.archived_at IS NULL
      ORDER BY d.kind <> 'main', d.pinned_position IS NULL, d.pinned_position,
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
          AND m.role = ${ROLE.assistant}
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
               wi.updated_at,
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
      SELECT space_id, stable_key, text, status, owner, updated_at
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
            kind: SPACE_UNSEEN.unseen,
            at: row.created_at,
            session_id: row.session_id,
            line: previewLine(row.search_text) ?? "",
            subject: letterSubject(row.subject)
          }
        ])
      )
      const spaceValues = yield* Effect.forEach(
        spaces,
        Effect.fn("SqliteSpaceStore.spaceValues.row")(function* (row) {
          const space = yield* decodeRow(row, "overview")
          return {
            key: space.space_id,
            kind: space.kind,
            title: space.name,
            page: publicPage(space.page_path),
            live: row.running_since !== null,
            pinned: row.pinned_position !== null,
            mark: publicMark(space.mark),
            updated_at: space.updated_at,
            unseen: unreadBySpace.get(space.space_id) ?? { kind: SPACE_UNSEEN.caught_up },
            last_line: lastLine(row.last_text)
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
          subject: letterSubject(row.subject)
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
