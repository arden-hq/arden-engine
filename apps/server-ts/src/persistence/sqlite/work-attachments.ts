import type { SpaceTaskAttachment } from "@arden-hq/protocol/spaces/work"
import {
  CreateSpaceTaskAttachmentInputSchema,
  type CreateSpaceTaskAttachmentRequest
} from "@arden-hq/protocol/effect/spaces/work"
import { DateTime, Effect, Schema } from "effect"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { WorkStoreError, type TaskAddress, type WorkStore } from "../work/store.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { assertRunTaskAuthority } from "./run-task-authority.js"
import { resolveTaskItem } from "./task-address.js"
import { decodeWorkAttachment, workError, type WorkAttachmentRow } from "./work-records.js"
import { actsAsPersonSql } from "./authority-sql.js"
import type { Writer } from "./deps.js"

interface WorkAttachmentContentRow extends WorkAttachmentRow {
  readonly data: Uint8Array
}

export const makeWorkAttachments = ({
  writer,
  sessionEvents
}: {
  readonly writer: Writer
  readonly sessionEvents: SessionLifecycleEvents["Service"]
}): Pick<WorkStore["Service"], "createAttachment" | "attachment"> => {
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
  const createAttachment = Effect.fn("SqliteWorkStore.createAttachment")(function* (
    address: TaskAddress,
    input: CreateSpaceTaskAttachmentRequest,
    runId?: string
  ): Effect.fn.Return<SpaceTaskAttachment, WorkStoreError> {
    const validInput = yield* Schema.decodeUnknownEffect(
      Schema.toType(CreateSpaceTaskAttachmentInputSchema)
    )(input).pipe(
      Effect.mapError((cause) => workError("invalid", "Invalid Space task attachment", cause))
    )
    const data = Uint8Array.from(validInput.data)

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const createdAt = DateTime.formatIso(yield* DateTime.now)
          const itemId = yield* resolveTaskItem(sql, address)
          const tasks = yield* sql<{ readonly item_id: string; readonly space_id: string | null }>`
        SELECT item_id, space_id FROM space_tasks WHERE item_id = ${itemId}
      `
          const task = tasks[0]
          if (task === undefined) return yield* workError("not_found", "Space task not found")

          if (runId !== undefined) {
            yield* assertRunTaskAuthority(sql, runId, task.item_id)
            const permitted = yield* sql`
          SELECT 1 FROM chat_runs WHERE run_id = ${runId}
            AND (${actsAsPersonSql(sql, sql`authority_json`)}
              OR json_extract(authority_json, '$.owns.space_id') = ${task.space_id}
              OR json_extract(authority_json, '$.owns.task_item_id') = ${task.item_id})
            AND NOT EXISTS (SELECT 1 FROM json_each(metadata_json, '$.run_policy.capabilities')
              WHERE value IN ('read_only', 'none'))
        `
            if (permitted.length === 0) {
              return yield* workError("conflict", "This Run cannot save a report on that Task")
            }
            const existing = yield* sql<WorkAttachmentRow>`
          SELECT attachment_id, space_id, item_id, name, media_type, size, created_by, created_at
          FROM space_task_attachments
          WHERE item_id = ${task.item_id} AND name = ${validInput.name}
            AND media_type = ${validInput.media_type} AND data = ${data} AND created_by = 'worker'
          ORDER BY attachment_id LIMIT 1
        `
            if (existing[0] !== undefined) {
              return yield* decodeWorkAttachment(existing[0])
            }
          }

          const rows = yield* sql<WorkAttachmentRow>`
        INSERT INTO space_task_attachments (
          space_id, item_id, name, media_type, data, size, created_by, created_at
        ) VALUES (
          ${task.space_id}, ${task.item_id}, ${validInput.name}, ${validInput.media_type},
          ${data}, ${data.byteLength}, ${runId === undefined ? "user" : "worker"}, ${createdAt}
        )
        RETURNING attachment_id, space_id, item_id, name, media_type, size, created_by, created_at
      `
          const row = rows[0]
          if (row === undefined)
            return yield* workError("storage", "Space task attachment insert returned no row")
          if (runId === undefined && task.space_id !== null)
            yield* spaceJobs.queueSpaceWake(task.space_id, createdAt)
          return yield* decodeWorkAttachment(row)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkStoreError
            ? cause
            : workError("storage", "Could not save the Task attachment", cause)
        )
      )
  })

  const attachment: WorkStore["Service"]["attachment"] = Effect.fn("SqliteWorkStore.attachment")(
    function* (attachmentId) {
      const validAttachmentId = yield* Schema.decodeUnknownEffect(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
      )(attachmentId).pipe(
        Effect.mapError((cause) =>
          workError("invalid", "Attachment id must be a positive integer", cause)
        )
      )
      const rows = yield* sql<WorkAttachmentContentRow>`
      SELECT attachment.attachment_id, attachment.space_id, attachment.item_id,
             attachment.name, attachment.media_type, attachment.data, attachment.size,
             attachment.created_by, attachment.created_at
      FROM space_task_attachments AS attachment
      JOIN space_tasks AS item
        ON item.item_id = attachment.item_id AND item.space_id IS attachment.space_id
      LEFT JOIN spaces AS space ON space.space_id = item.space_id
      WHERE attachment.attachment_id = ${validAttachmentId}
        AND (item.space_id IS NULL OR space.archived_at IS NULL)
      LIMIT 1
    `.pipe(
        Effect.mapError((cause) =>
          workError("storage", "Could not load Space task attachment", cause)
        )
      )
      const row = rows[0]
      if (row === undefined) return null
      const { data, ...metadataRow } = row
      return { metadata: yield* decodeWorkAttachment(metadataRow), data: Uint8Array.from(data) }
    }
  )
  return { createAttachment, attachment }
}
