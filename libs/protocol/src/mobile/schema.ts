import { Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  RuntimeRunStatusSchema
} from "../common/schema.js"
import { ChatSentFromSchema } from "../chat/schema.js"
import { SPACE_TONE } from "../views/space-state.js"

const Id = Schema.NonEmptyString
const At = IsoDateTimeStringSchema
const Seq = NonNegativeIntSchema

export const MOBILE_DIFF_LINE = { context: "context", added: "added", removed: "removed" } as const

export const MOBILE_CHANGE = { diff: "diff", command: "command", summary: "summary" } as const

export const MOBILE_ASK = { question: "question", approval: "approval" } as const

export const MOBILE_CONVERSATION_ITEM = {
  user: "user",
  reply: "reply",
  handoff: "handoff",
  sender: "sender",
  sent: "sent"
} as const

export const MobileDiffLineSchema = Schema.Struct({
  kind: Schema.Literals(Object.values(MOBILE_DIFF_LINE)),
  text: Schema.String
})

export const MobileChangeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(MOBILE_CHANGE.diff),
    files: Schema.Array(
      Schema.Struct({ file: Schema.String, lines: Schema.Array(MobileDiffLineSchema) })
    )
  }),
  Schema.Struct({ kind: Schema.Literal(MOBILE_CHANGE.command), command: Schema.String }),
  Schema.Struct({ kind: Schema.Literal(MOBILE_CHANGE.summary), text: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

export const MOBILE_FILING = { loose: "loose", space: "space" } as const
export const MOBILE_CHAT_LINK = { unlinked: "unlinked", linked: "linked" } as const

export const MobileFilingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(MOBILE_FILING.loose) }),
  Schema.Struct({ kind: Schema.Literal(MOBILE_FILING.space), space_id: Id })
]).pipe(Schema.toTaggedUnion("kind"))

export const MobileDetailSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("plain") }),
  Schema.Struct({ kind: Schema.Literal("detailed"), text: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

export const MobileChatLinkSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(MOBILE_CHAT_LINK.unlinked) }),
  Schema.Struct({ kind: Schema.Literal(MOBILE_CHAT_LINK.linked), session_id: Id })
]).pipe(Schema.toTaggedUnion("kind"))

const askPlace = {
  session_id: Id,
  space: MobileFilingSchema,
  place: Schema.String,
  asked_at: At
} as const

export const MobileAskSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(MOBILE_ASK.question),
    question_id: Id,
    run_id: Id,
    ...askPlace,
    prompt: Schema.String,
    detail: MobileDetailSchema,
    multiple: Schema.Boolean,
    options: Schema.Array(
      Schema.Struct({ id: Id, label: Schema.String, detail: MobileDetailSchema })
    )
  }),
  Schema.Struct({
    kind: Schema.Literal(MOBILE_ASK.approval),
    run_id: Id,
    tool_id: Id,
    ...askPlace,
    title: Schema.String,
    change: MobileChangeSchema
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const MOBILE_LINK = { session: "session", space: "space", url: "url" } as const

export const MobileLinkSchema = Schema.Struct({
  kind: Schema.Literals(Object.values(MOBILE_LINK)),
  id: Id
})

export const MobileLetterSchema = Schema.Struct({
  run_id: Id,
  generated_at: At,
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
  cursor: Seq
})

export const MobileStateLineSchema = Schema.Struct({
  tone: Schema.Literals(Object.values(SPACE_TONE)),
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
  loose: Schema.Array(
    Schema.Struct({
      session_id: Id,
      title: Schema.String,
      has_unread: Schema.Boolean,
      run: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("unrun") }),
        Schema.Struct({ kind: Schema.Literal("run"), status: RuntimeRunStatusSchema })
      ]),
      working: Schema.Boolean,
      updated_at: At
    })
  ),
  cursor: Seq
})

export const MobileConversationItemSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(MOBILE_CONVERSATION_ITEM.user),
    id: Id,
    client: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("untracked") }),
      Schema.Struct({ kind: Schema.Literal("tracked"), client_id: Schema.String })
    ]),
    text: Schema.String,
    photos: Seq,
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
  Schema.Struct({
    kind: Schema.Literal(MOBILE_CONVERSATION_ITEM.reply),
    id: Id,
    markdown: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal(MOBILE_CONVERSATION_ITEM.handoff),
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
    kind: Schema.Literal(MOBILE_CONVERSATION_ITEM.sender),
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
    preview: Schema.String,
    body: Schema.String,
    failed: Schema.Boolean,
    at: At
  }),
  Schema.Struct({
    kind: Schema.Literal(MOBILE_CONVERSATION_ITEM.sent),
    id: Id,
    chat: MobileChatLinkSchema,
    title: Schema.String
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const MobileConversationSchema = Schema.Struct({
  session_id: Id,
  title: Schema.String,
  space: MobileFilingSchema,
  items: Schema.Array(MobileConversationItemSchema),
  live: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("idle") }),
    Schema.Struct({ kind: Schema.Literal("running"), text: Schema.String, started_at: At })
  ]),
  chats: Schema.Array(
    Schema.Struct({ session_id: Id, title: Schema.String, updated_at: At, working: Schema.Boolean })
  ),
  before: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("beginning") }),
    Schema.Struct({ kind: Schema.Literal("earlier"), cursor: Schema.String })
  ]),
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
