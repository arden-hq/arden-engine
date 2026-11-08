import type {
  SpaceTaskAttachment,
  SpaceTaskComment,
  SpaceTaskEvent
} from "@arden-hq/protocol/spaces/work"
import {
  SpaceTaskAttachmentSchema,
  SpaceTaskCommentSchema,
  SpaceTaskEventSchema,
  EvidenceSourceRefSchema
} from "@arden-hq/protocol/effect/spaces/work"
import { Effect, Schema } from "effect"
import { WorkStoreError } from "../work/store.js"
import { decodeJson } from "./json.js"
import { inArdenWords } from "../restart-notice.js"

export interface WorkCommentRow {
  readonly comment_id: number
  readonly space_id: string | null
  readonly item_id: string
  readonly author: string
  readonly body: string
  readonly created_at: string
  readonly kind: string
}

export interface WorkEventRow {
  readonly event_id: number
  readonly space_id: string | null
  readonly item_id: string
  readonly run_ref: string | null
  readonly event_type: string
  readonly summary: string
  readonly content_kind: string
  readonly source_refs: string
  readonly created_at: string
}

export interface WorkAttachmentRow {
  readonly attachment_id: number
  readonly space_id: string | null
  readonly item_id: string
  readonly name: string
  readonly media_type: string
  readonly size: number
  readonly created_by: string
  readonly created_at: string
}

const evidenceSourceRefsSchema = Schema.Array(EvidenceSourceRefSchema)

export const workError = (
  reason: "invalid" | "not_found" | "conflict" | "storage",
  message: string,
  cause?: unknown
): WorkStoreError =>
  new WorkStoreError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const decodeWorkAttachment = Effect.fn("SqliteWorkStore.decodeWorkAttachment")(function* (
  row: WorkAttachmentRow
): Effect.fn.Return<SpaceTaskAttachment, WorkStoreError> {
  return yield* Schema.decodeUnknownEffect(SpaceTaskAttachmentSchema)(row).pipe(
    Effect.mapError((cause) =>
      workError("storage", "Stored Space work attachment is corrupt", cause)
    )
  )
})

export const decodeWorkEvent = Effect.fn("SqliteWorkStore.decodeWorkEvent")(function* (
  row: WorkEventRow
): Effect.fn.Return<SpaceTaskEvent, WorkStoreError> {
  const source_refs = yield* decodeJson(evidenceSourceRefsSchema, row.source_refs).pipe(
    Effect.mapError((cause) =>
      workError("storage", "Stored Space task event evidence is corrupt", cause)
    )
  )
  const { summary, content_kind, ...event } = row
  return yield* Schema.decodeUnknownEffect(SpaceTaskEventSchema)({
    ...event,
    source_refs,
    content: { kind: content_kind, text: inArdenWords(summary) }
  }).pipe(
    Effect.mapError((cause) => workError("storage", "Stored Space task event is corrupt", cause))
  )
})

export const decodeWorkComment = Effect.fn("SqliteWorkStore.decodeWorkComment")(function* (
  row: WorkCommentRow
): Effect.fn.Return<SpaceTaskComment, WorkStoreError> {
  return yield* Schema.decodeUnknownEffect(SpaceTaskCommentSchema)(row).pipe(
    Effect.mapError((cause) => workError("storage", "Stored Space work comment is corrupt", cause))
  )
})
