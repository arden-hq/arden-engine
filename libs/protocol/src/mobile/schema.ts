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

export const MOBILE_FILING = { loose: "loose", space: "space" } as const
export const MOBILE_CHAT_LINK = { unlinked: "unlinked", linked: "linked" } as const

export const MobileFilingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("loose") }),
  Schema.Struct({ kind: Schema.Literal("space"), space_id: Id })
]).pipe(Schema.toTaggedUnion("kind"))

export const MobileDetailSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("plain") }),
  Schema.Struct({ kind: Schema.Literal("detailed"), text: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

export const MobileChatLinkSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unlinked") }),
  Schema.Struct({ kind: Schema.Literal("linked"), session_id: Id })
]).pipe(Schema.toTaggedUnion("kind"))

const askPlace = {
  session_id: Id,
  space: MobileFilingSchema,
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
    detail: MobileDetailSchema,
    /** True when the answer may pick several options (`answer` with `option_ids`). */
    multiple: Schema.Boolean,
    /** Empty for a free-text answer. */
    options: Schema.Array(
      Schema.Struct({ id: Id, label: Schema.String, detail: MobileDetailSchema })
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
    Schema.Array(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
        Schema.Struct({ kind: Schema.Literal("link"), text: Schema.String, link: MobileLinkSchema })
      ])
    )
  )
})

export const MobileHomeSchema = Schema.Struct({
  asks: Schema.Array(MobileAskSchema),
  letter: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("awaiting") }),
    Schema.Struct({ kind: Schema.Literal("written"), ...MobileLetterSchema.fields })
  ]),
  next: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("paused") }),
    Schema.Struct({ kind: Schema.Literal("due"), at: At })
  ]),
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
      conversation: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("unopened") }),
        Schema.Struct({ kind: Schema.Literal("opened"), session_id: Id })
      ]),
      state_line: MobileStateLineSchema
    })
  ),
  /** Chats filed on no Space, most recent first. */
  loose: Schema.Array(
    Schema.Struct({
      session_id: Id,
      title: Schema.String,
      has_unread: Schema.Boolean,
      run: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("unrun") }),
        Schema.Struct({ kind: Schema.Literal("run"), status: RuntimeRunStatusSchema })
      ]),
      /** The chat has a run in flight (`isActiveRunStatus`); the one rule for the ring. */
      working: Schema.Boolean,
      updated_at: At
    })
  ),
  cursor: Seq
})

/** One row of a conversation, in time order: what you said, what Arden
 *  replied, and what arrived from elsewhere — a chat's handoff, a sender's row
 *  (an agent, an automation, a workflow, a command), news of a Task or run, and
 *  a line for each chat Arden sent to.
 *  Markdown links are rewritten to `arden://session|space|task/<id>`; a link
 *  the phone cannot open is left as its words. */
export const MobileConversationItemSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user"),
    id: Id,
    client: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("untracked") }),
      Schema.Struct({ kind: Schema.Literal("tracked"), client_id: Schema.String })
    ]),
    text: Schema.String,
    /** How many photos the message carried. */
    photos: Seq,
    /** The names of the files it attached by path; the paths stay on the Mac. */
    files: Schema.Array(Schema.String),
    reply_to: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("fresh") }),
      Schema.Struct({
        kind: Schema.Literal("quote"),
        role: Schema.Literals(["user", "assistant"]),
        text: Schema.String
      })
    ]),
    sent_from: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("typed") }),
      Schema.Struct({ kind: Schema.Literal("surface"), surface: ChatSentFromSchema })
    ])
  }),
  Schema.Struct({ kind: Schema.Literal("reply"), id: Id, markdown: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("handoff"),
    id: Id,
    from_session_id: Id,
    from_title: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("unnamed") }),
      Schema.Struct({ kind: Schema.Literal("named"), title: Schema.String })
    ]),
    markdown: Schema.String,
    at: At
  }),
  Schema.Struct({
    kind: Schema.Literal("sender"),
    id: Id,
    sender: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("workflow") }),
      Schema.Struct({ kind: Schema.Literals(["automation", "command"]), name: Schema.String }),
      Schema.Struct({
        kind: Schema.Literal("agent"),
        name: Schema.String,
        chat: MobileChatLinkSchema
      })
    ]),
    /** One line of inline Markdown for the row. */
    preview: Schema.String,
    /** The whole text, for reading it. */
    body: Schema.String,
    /** True when the sender says its work did not complete. */
    failed: Schema.Boolean,
    at: At
  }),
  Schema.Struct({
    kind: Schema.Literal("sent"),
    /** The send's tool call. */
    id: Id,
    chat: MobileChatLinkSchema,
    title: Schema.String
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const MobileConversationSchema = Schema.Struct({
  session_id: Id,
  title: Schema.String,
  space: MobileFilingSchema,
  /** Oldest first. */
  items: Schema.Array(MobileConversationItemSchema),
  live: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("idle") }),
    Schema.Struct({ kind: Schema.Literal("running"), text: Schema.String, started_at: At })
  ]),
  /** The other chats of the same Space; empty for a loose chat. */
  chats: Schema.Array(
    Schema.Struct({ session_id: Id, title: Schema.String, updated_at: At, working: Schema.Boolean })
  ),
  before: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("beginning") }),
    Schema.Struct({ kind: Schema.Literal("earlier"), cursor: Schema.String })
  ]),
  /** The chat stream position this page reflects (`GET /chat/events/:id`). */
  latest_event_seq: Seq
})

export type MobileFiling = typeof MobileFilingSchema.Type
export type MobileDetail = typeof MobileDetailSchema.Type
export type MobileChatLink = typeof MobileChatLinkSchema.Type
export type MobileChange = typeof MobileChangeSchema.Type
export type MobileAsk = typeof MobileAskSchema.Type
export type MobileLink = typeof MobileLinkSchema.Type
export type MobileLetter = typeof MobileLetterSchema.Type
export type MobileHome = typeof MobileHomeSchema.Type
export type MobileStateLine = typeof MobileStateLineSchema.Type
export type MobileSpaces = typeof MobileSpacesSchema.Type
export type MobileConversationItem = typeof MobileConversationItemSchema.Type
export type MobileConversation = typeof MobileConversationSchema.Type
