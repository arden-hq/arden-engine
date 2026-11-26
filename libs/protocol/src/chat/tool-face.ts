import { Schema } from "effect"
import type { Agrees, Assert } from "../common/type-agreement.js"
import type { JsonRecord } from "../common/json.js"
import { GmailSendReceiptSchema } from "./gmail-receipt.js"
import type { GmailSendReceipt } from "./history.js"

export const TOOL_EXECUTIONS = ["runtime", "provider"] as const
export type ToolExecution = (typeof TOOL_EXECUTIONS)[number]
export const TOOL_EXECUTION = { runtime: "runtime", provider: "provider" } as const

export const TOOL_PRESENTATIONS = ["work", "conversation", "status"] as const
export type ToolPresentation = (typeof TOOL_PRESENTATIONS)[number]
export const TOOL_PRESENTATION = {
  work: "work",
  conversation: "conversation",
  status: "status"
} as const

export const DEFAULT_TOOL_KIND = "tool"

export const TOOL_PARENT = { root: "root", child: "child" } as const
export type ToolParent =
  | { readonly kind: typeof TOOL_PARENT.root }
  | { readonly kind: typeof TOOL_PARENT.child; readonly parent_id: string }

export const TOOL_TITLE = { untitled: "untitled", titled: "titled" } as const
export type ToolTitle =
  | { readonly kind: typeof TOOL_TITLE.untitled }
  | { readonly kind: typeof TOOL_TITLE.titled; readonly text: string }

export const TOOL_ICON = { plain: "plain", icon: "icon" } as const
export type ToolIcon =
  | { readonly kind: typeof TOOL_ICON.plain }
  | { readonly kind: typeof TOOL_ICON.icon; readonly name: string }

export const TOOL_NOUN = { unnamed: "unnamed", noun: "noun" } as const
export type ToolNoun =
  | { readonly kind: typeof TOOL_NOUN.unnamed }
  | { readonly kind: typeof TOOL_NOUN.noun; readonly text: string }

export const TOOL_SOURCE = { unsourced: "unsourced", source: "source" } as const
export type ToolSource =
  | { readonly kind: typeof TOOL_SOURCE.unsourced }
  | { readonly kind: typeof TOOL_SOURCE.source; readonly name: string }

export interface ToolFace {
  readonly parent: ToolParent
  readonly display_name: string
  readonly title: ToolTitle
  readonly kind: string
  readonly icon: ToolIcon
  readonly noun: ToolNoun
  readonly source: ToolSource
  readonly presentation: ToolPresentation
  readonly execution: ToolExecution
}

export const TOOL_RETRY = { retryable: "retryable", final: "final", unstated: "unstated" } as const
export type ToolRetry = (typeof TOOL_RETRY)[keyof typeof TOOL_RETRY]

export const toolRetry = (retryable: boolean | null): ToolRetry => {
  if (retryable === null) return TOOL_RETRY.unstated
  return retryable ? TOOL_RETRY.retryable : TOOL_RETRY.final
}

export const TOOL_DATA = { none: "none", attached: "attached" } as const
export type ToolData =
  | { readonly kind: typeof TOOL_DATA.none }
  | { readonly kind: typeof TOOL_DATA.attached; readonly value: JsonRecord }

export const GMAIL_SEND = { unconfirmed: "unconfirmed", confirmed: "confirmed" } as const
export type GmailSend =
  | { readonly kind: typeof GMAIL_SEND.unconfirmed }
  | { readonly kind: typeof GMAIL_SEND.confirmed; readonly receipt: GmailSendReceipt }

const tagged = <const Tag extends string>(kind: Tag) =>
  Schema.Struct({ kind: Schema.Literal(kind) })

export const ToolExecutionSchema = Schema.Literals(TOOL_EXECUTIONS)

export const ToolFaceFields = {
  parent: Schema.Union([
    tagged(TOOL_PARENT.root),
    Schema.Struct({ kind: Schema.Literal(TOOL_PARENT.child), parent_id: Schema.String })
  ]),
  display_name: Schema.String,
  title: Schema.Union([
    tagged(TOOL_TITLE.untitled),
    Schema.Struct({ kind: Schema.Literal(TOOL_TITLE.titled), text: Schema.String })
  ]),
  kind: Schema.String,
  icon: Schema.Union([
    tagged(TOOL_ICON.plain),
    Schema.Struct({ kind: Schema.Literal(TOOL_ICON.icon), name: Schema.String })
  ]),
  noun: Schema.Union([
    tagged(TOOL_NOUN.unnamed),
    Schema.Struct({ kind: Schema.Literal(TOOL_NOUN.noun), text: Schema.String })
  ]),
  source: Schema.Union([
    tagged(TOOL_SOURCE.unsourced),
    Schema.Struct({ kind: Schema.Literal(TOOL_SOURCE.source), name: Schema.String })
  ]),
  presentation: Schema.Literals(TOOL_PRESENTATIONS),
  execution: ToolExecutionSchema
}

export const ToolRetrySchema = Schema.Literals([
  TOOL_RETRY.retryable,
  TOOL_RETRY.final,
  TOOL_RETRY.unstated
] as const)

export const ToolDataSchema = Schema.Union([
  tagged(TOOL_DATA.none),
  Schema.Struct({
    kind: Schema.Literal(TOOL_DATA.attached),
    value: Schema.Record(Schema.String, Schema.Unknown)
  })
])

export const GmailSendSchema = Schema.Union([
  tagged(GMAIL_SEND.unconfirmed),
  Schema.Struct({ kind: Schema.Literal(GMAIL_SEND.confirmed), receipt: GmailSendReceiptSchema })
])

export type ToolFaceAgrees = Assert<Agrees<Schema.Struct<typeof ToolFaceFields>["Type"], ToolFace>>

export type ToolDataAgrees = Assert<Agrees<typeof ToolDataSchema.Type, ToolData>>

export type GmailSendAgrees = Assert<Agrees<typeof GmailSendSchema.Type, GmailSend>>
