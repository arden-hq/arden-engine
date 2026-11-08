import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, RuntimeRunStatusSchema } from "../common/schema.js"
import { RunContextSchema } from "./context.js"
import { RunQuestionSchema } from "./questions.js"

const identity = Schema.NonEmptyString
const at = IsoDateTimeStringSchema
const source = { id: identity, at }

/**
 * A Home suggestion as a letter cites it (I-23, D22): the words a letter was
 * written from, stored with the letter. The live suggestion is the Task
 * proposal of the same id (`@arden-hq/protocol/proposals`). `space_id` is the
 * Space its Task went on.
 */
export const HomeOfferSchema = Schema.Struct({
  offer_id: identity,
  text: Schema.String,
  why: Schema.String,
  /** Absent for suggestions grounded in memory or chats rather than an outside item. */
  item: Schema.NullOr(
    Schema.Struct({
      /** Null once the item itself expired (30 days); the offer keeps its words. */
      item_id: Schema.NullOr(identity),
      /** A signal source id (`@arden-hq/protocol/signals`); any id, so a new source needs no client release. */
      source: Schema.NonEmptyString,
      title: Schema.String,
      from: Schema.NullOr(Schema.String)
    })
  ),
  status: Schema.Literals(["held", "offered", "accepted", "rejected"]),
  revision: Schema.Natural,
  space_id: Schema.NullOr(identity),
  task_item_id: Schema.NullOr(identity),
  created_at: at,
  updated_at: at,
  settled_at: Schema.NullOr(at)
})
export type HomeOffer = typeof HomeOfferSchema.Type

/** Home reads canonical work; these records never grant permission to act. */
export const HomeEvidenceSchema = Schema.Union([
  Schema.Struct({
    ...source,
    kind: Schema.Literal("task"),
    event_id: Schema.NullOr(Schema.Natural),
    item_id: identity,
    /** Absent on letters saved before Task history; null when no exact event version was recorded. */
    history_revision: Schema.optionalKey(Schema.NullOr(identity)),
    title: Schema.String,
    event_type: identity,
    summary: Schema.String,
    status: Schema.Literals(["open", "done", "cancelled"]),
    source_refs: Schema.Array(Schema.Json),
    run_ref: Schema.NullOr(identity)
  }),
  Schema.Struct({
    ...source,
    kind: Schema.Literal("run"),
    run_id: identity,
    session_id: identity,
    context: RunContextSchema,
    status: RuntimeRunStatusSchema,
    text: Schema.String,
    error: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({ ...source, kind: Schema.Literal("question"), question: RunQuestionSchema }),
  Schema.Struct({
    ...source,
    kind: Schema.Literal("approval"),
    run_id: identity,
    session_id: identity,
    tool_call_id: identity,
    tool_name: identity,
    preview: Schema.NullOr(Schema.String),
    context: Schema.NullOr(RunContextSchema)
  }),
  /** An open Home offer; a letter phrase citing it opens its card with Start (D22). */
  Schema.Struct({ ...source, kind: Schema.Literal("offer"), offer: HomeOfferSchema })
])

export const HomeEvidenceQuerySchema = Schema.Struct({
  since: at,
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)))
})
/** The Home headline, a persisted code value: the owner never sees it, and stored
 *  letter snapshots carry it, so renaming it is a data migration. */
export const HOME_HEADLINES = ["Nothing needs you", "Since your last visit"] as const

export const HomeEvidencePageSchema = Schema.Struct({
  window: Schema.Struct({ since: at, through: at }),
  headline: Schema.Literals(HOME_HEADLINES),
  entries: Schema.Array(HomeEvidenceSchema),
  next_cursor: Schema.NullOr(identity)
})
export type HomeEvidence = typeof HomeEvidenceSchema.Type
export type HomeEvidenceQuery = typeof HomeEvidenceQuerySchema.Type
export type HomeEvidencePage = typeof HomeEvidencePageSchema.Type
export const encodeHomeEvidencePathEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(HomeEvidenceQuerySchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.map((query) => {
      const params = new URLSearchParams({ since: query.since })
      if (query.cursor) params.set("cursor", query.cursor)
      return `/home/evidence?${params}`
    })
  )

export const HomePresenceInputSchema = Schema.Struct({
  client_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  sequence: Schema.Natural,
  active: Schema.Boolean
})
export const HomeLetterBodySchema = Schema.Struct({
  paragraphs: Schema.Array(
    Schema.Array(
      Schema.Struct({
        text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
        source_id: Schema.NullOr(identity),
        /** On a read, where a linked phrase goes: an `arden:`, web or file link,
         *  or null when its evidence names no place (Home shows what happened). */
        href: Schema.optionalKey(Schema.NullOr(Schema.String))
      })
    ).check(Schema.isMinLength(1), Schema.isMaxLength(12))
  ).check(Schema.isMaxLength(2))
})
/** One filed letter: what Arden wrote at its hour, over the half-day it covers. */
export const HomeLetterSchema = Schema.Struct({
  run_id: identity,
  generated_at: at,
  window: Schema.Struct({ since: at, through: at }),
  body: HomeLetterBodySchema,
  sources: Schema.Array(HomeEvidenceSchema)
})
export const HomeLetterResponseSchema = Schema.Struct({
  generation: Schema.Literals(["idle", "pending", "running"]),
  /** The open window the next letter covers. */
  window: Schema.Struct({ id: identity, since: at }),
  headline: Schema.Literals(HOME_HEADLINES),
  /** Newest first. */
  letters: Schema.Array(HomeLetterSchema),
  /** When the next letter is due on the clock; null while letters are paused. */
  next_at: Schema.NullOr(at)
})
export type HomePresenceInput = typeof HomePresenceInputSchema.Type
export type HomeLetterBody = typeof HomeLetterBodySchema.Type
export type HomeLetter = typeof HomeLetterSchema.Type
export type HomeLetterResponse = typeof HomeLetterResponseSchema.Type
export const HomePresenceResponseSchema = Schema.Struct({ ok: Schema.Literal(true) })
export const encodeHomePresenceEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(HomePresenceInputSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.map(JSON.stringify)
  )
