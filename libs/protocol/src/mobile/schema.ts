import { Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  RuntimeRunStatusSchema
} from "../common/schema.js"
import { ChatSentFromSchema } from "../chat/schema.js"

/**
 * The phone's views: thin compositions the server derives with the same
 * functions the desktop reads (`@arden-hq/protocol/views`), so the two surfaces
 * cannot word one state two ways. Writes are not here — the phone reuses the
 * ordinary chat, cancel, approval and answer routes.
 *
 * Every field is required; absence is `null`, so a Codable client needs no
 * optional handling beyond nullability.
 */

const Id = Schema.NonEmptyString
const At = IsoDateTimeStringSchema
const Seq = NonNegativeIntSchema

/** One line of a change preview. */
export const MobileDiffLineSchema = Schema.Struct({
  kind: Schema.Literals(["context", "added", "removed"]),
  text: Schema.String
})

/** What an approval would change: the file edit itself, the command it would
 *  run, else one line saying what it does. */
export const MobileChangeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("diff"),
    files: Schema.Array(
      Schema.Struct({ file: Schema.String, lines: Schema.Array(MobileDiffLineSchema) })
    )
  }),
  Schema.Struct({ kind: Schema.Literal("command"), command: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("summary"), text: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

/** Where an ask was raised: its chat, and the Space it is filed on. `place` is
 *  the name to show — the Space's when the chat is its home, else the chat's. */
const askPlace = {
  session_id: Id,
  space_id: Schema.NullOr(Id),
  place: Schema.String,
  asked_at: At
} as const

/** Something Arden asks the person, in the order they should see them. */
export const MobileAskSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("question"),
    question_id: Id,
    run_id: Id,
    ...askPlace,
    prompt: Schema.String,
    detail: Schema.NullOr(Schema.String),
    /** True when the answer may pick several options (`answer` with `option_ids`). */
    multiple: Schema.Boolean,
    /** Empty for a free-text answer. */
    options: Schema.Array(
      Schema.Struct({ id: Id, label: Schema.String, detail: Schema.NullOr(Schema.String) })
    )
  }),
  Schema.Struct({
    kind: Schema.Literal("approval"),
    run_id: Id,
    /** The tool call; `POST /tools/result {run_id, tool_id}` settles it. */
    tool_id: Id,
    ...askPlace,
    title: Schema.String,
    change: MobileChangeSchema
  })
]).pipe(Schema.toTaggedUnion("kind"))

/** Where a linked phrase in a letter opens. A `url` link's id is the URL. */
export const MobileLinkSchema = Schema.Struct({
  kind: Schema.Literals(["session", "space", "url"]),
  id: Id
})

export const MobileLetterSchema = Schema.Struct({
  run_id: Id,
  generated_at: At,
  /** Paragraphs of segments; a segment with a link is a tappable phrase. */
  paragraphs: Schema.Array(
    Schema.Array(Schema.Struct({ text: Schema.String, link: Schema.NullOr(MobileLinkSchema) }))
  )
})

export const MobileHomeSchema = Schema.Struct({
  asks: Schema.Array(MobileAskSchema),
  /** The newest letter with something to say; null before the first. */
  letter: Schema.NullOr(MobileLetterSchema),
  /** When the next letter is due on the clock; null while letters are paused. */
  next_at: Schema.NullOr(At),
  /** The global bus head (`GET /automations/events?after_seq=`) this view reflects. */
  cursor: Seq
})

/** A Space's line under its name. `more` counts further asks after the one
 *  shown; it is 0 unless `tone` is "asks". */
export const MobileStateLineSchema = Schema.Struct({
  tone: Schema.Literals(["working", "asks", "quiet"]),
  text: Schema.String,
  more: Seq
})

export const MobileSpacesSchema = Schema.Struct({
  spaces: Schema.Array(
    Schema.Struct({
      id: Id,
      name: Schema.String,
      /** The Space's own conversation; null until it has one (opening the Space
       *  with `POST /spaces/:id/conversation` makes it). */
      conversation_session_id: Schema.NullOr(Id),
      state_line: MobileStateLineSchema
    })
  ),
  /** Chats filed on no Space, most recent first. */
  loose: Schema.Array(
    Schema.Struct({
      session_id: Id,
      title: Schema.String,
      has_unread: Schema.Boolean,
      run_status: Schema.NullOr(RuntimeRunStatusSchema),
      /** The chat has a run in flight (`isActiveRunStatus`); the one rule for the ring. */
      working: Schema.Boolean,
      updated_at: At
    })
  ),
  cursor: Seq
})

/** One row of a conversation, in time order: what you said, one fold line
 *  for a turn's work, what Arden replied, and what arrived from elsewhere —
 *  a chat's handoff, a sender's row (an agent, an automation, a workflow, a
 *  command), news of a Task or run, and a line for each chat Arden sent to.
 *  Markdown links are rewritten to `arden://session|space|task/<id>`; a link
 *  the phone cannot open is left as its words. */
export const MobileConversationItemSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user"),
    id: Id,
    /** The sender's retry identity, which confirms an optimistic bubble. */
    client_id: Schema.NullOr(Schema.String),
    text: Schema.String,
    /** How many photos the message carried. */
    photos: Seq,
    /** The names of the files it attached by path; the paths stay on the Mac. */
    files: Schema.Array(Schema.String),
    /** The message this one replies to, as one plain line. */
    reply_to: Schema.NullOr(
      Schema.Struct({ role: Schema.Literals(["user", "assistant"]), text: Schema.String })
    ),
    /** The Recipe the message was started from, by its name. */
    recipe: Schema.NullOr(Schema.String),
    /** The UI surface that wrote the message's words for the person to confirm. */
    sent_from: Schema.NullOr(ChatSentFromSchema)
  }),
  Schema.Struct({
    kind: Schema.Literal("work"),
    turn_id: Id,
    /** What the turn did ("Read files, searched email"), or how it ended. */
    summary: Schema.String,
    /** The turn's length, shown after the summary as its quiet second part;
     *  null when the summary already says it (or it is unknown). */
    seconds: Schema.NullOr(Seq)
  }),
  Schema.Struct({ kind: Schema.Literal("reply"), id: Id, markdown: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("handoff"),
    id: Id,
    /** The chat it came from: its id, and its name when the server has one. */
    from_session_id: Schema.NullOr(Id),
    from_title: Schema.NullOr(Schema.String),
    markdown: Schema.String,
    at: At
  }),
  Schema.Struct({
    kind: Schema.Literal("sender"),
    id: Id,
    sender: Schema.Literals(["agent", "automation", "workflow", "command"]),
    /** The agent's or automation's name; null for a workflow, which has none. */
    name: Schema.NullOr(Schema.String),
    /** One line of inline Markdown for the row. */
    preview: Schema.String,
    /** The whole text, for reading it. */
    body: Schema.String,
    /** True when the sender says its work did not complete. */
    failed: Schema.Boolean,
    /** The agent's own chat, when it has one the phone can open. */
    session_id: Schema.NullOr(Id),
    at: At
  }),
  Schema.Struct({
    kind: Schema.Literal("sent"),
    /** The send's tool call. */
    id: Id,
    session_id: Schema.NullOr(Id),
    title: Schema.String
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const MobileConversationSchema = Schema.Struct({
  session_id: Id,
  title: Schema.String,
  space_id: Schema.NullOr(Id),
  /** Oldest first. */
  items: Schema.Array(MobileConversationItemSchema),
  /** The running turn's one live line; null when nothing runs. */
  live_row: Schema.NullOr(Schema.Struct({ text: Schema.String, started_at: At })),
  /** The other chats of the same Space; empty for a loose chat. */
  chats: Schema.Array(
    Schema.Struct({ session_id: Id, title: Schema.String, updated_at: At, working: Schema.Boolean })
  ),
  /** Pass as `?before=` for the page before this one; null at the start. */
  before: Schema.NullOr(Schema.String),
  /** The chat stream position this page reflects (`GET /chat/events/:id`). */
  latest_event_seq: Seq
})

/** One step of a turn's tool rail: a call, or what Arden said between calls. */
export const MobileTurnStepSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool"),
    /** The tool call's id. */
    id: Id,
    /** The call's label as the desktop row shows it: the model's title for
     *  the call, else the tool's verb ("Searched email"). */
    title: Schema.String,
    /** What the call acted on (a path, query, command), one line; null when
     *  its arguments name nothing a reader can use. */
    detail: Schema.NullOr(Schema.String),
    state: Schema.Literals(["done", "failed", "running"]),
    /** How long the call ran; null while it runs or when unknown. */
    seconds: Schema.NullOr(Seq)
  }),
  Schema.Struct({
    kind: Schema.Literal("note"),
    id: Id,
    /** Plain text or Markdown, clipped. */
    text: Schema.String
  })
]).pipe(Schema.toTaggedUnion("kind"))

/** One turn's work, step by step, for the phone's rail under a fold line. */
export const MobileTurnSchema = Schema.Struct({
  turn_id: Id,
  /** The fold line the conversation shows for this turn. */
  summary: Schema.String,
  /** As on the conversation's work item: null when the summary already says
   *  it, while the turn runs, or when unknown. */
  seconds: Schema.NullOr(Seq),
  /** Oldest first; a long turn ends with a note counting the steps left out. */
  steps: Schema.Array(MobileTurnStepSchema)
})

export type MobileChange = typeof MobileChangeSchema.Type
export type MobileAsk = typeof MobileAskSchema.Type
export type MobileLink = typeof MobileLinkSchema.Type
export type MobileLetter = typeof MobileLetterSchema.Type
export type MobileHome = typeof MobileHomeSchema.Type
export type MobileStateLine = typeof MobileStateLineSchema.Type
export type MobileSpaces = typeof MobileSpacesSchema.Type
export type MobileConversationItem = typeof MobileConversationItemSchema.Type
export type MobileConversation = typeof MobileConversationSchema.Type
export type MobileTurnStep = typeof MobileTurnStepSchema.Type
export type MobileTurn = typeof MobileTurnSchema.Type
