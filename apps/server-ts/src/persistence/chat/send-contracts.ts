import type {
  ChatApprovalMode,
  ChatCaptureVia,
  ChatImageInput,
  ChatReceiptStatus,
  ChatReplyContext,
  ChatSentFrom,
  StandingRuleList,
  ToolApprovalAlternative
} from "@arden-hq/protocol/chat"
import { ChatIdentifierSchema } from "@arden-hq/protocol/effect/chat"
import { Schema } from "effect"

type JsonValue = Schema.Json

export interface ChatSendReceipt {
  readonly runId: string | null
  readonly sessionId: string
  readonly status: ChatReceiptStatus
  readonly clientId: string
}

export interface ChatMessageFields {
  readonly sessionId: string
  readonly clientId?: string
  readonly message: string
  readonly images?: ReadonlyArray<ChatImageInput>
  readonly replyTo?: ChatReplyContext | ReadonlyArray<ChatReplyContext>
  readonly approvalReply?: { readonly runId: string; readonly toolId: string }
  readonly approvalMode?: ChatApprovalMode
  readonly sentFrom?: ChatSentFrom
  readonly capture?: ChatCaptureVia
  readonly outputSchema?: { readonly [key: string]: JsonValue }
}

export type RunCancelTarget =
  | { readonly runId: string; readonly sessionId?: never; readonly holdQueue?: never }
  | { readonly sessionId: string; readonly runId?: never; readonly holdQueue?: boolean }

export interface ToolDecisionFields {
  readonly runId: string
  readonly toolId: string
  readonly result: string
  readonly approved?: boolean
  readonly grantStanding?: boolean
  readonly grantList?: StandingRuleList
  readonly attachFolderToSpace?: boolean
  readonly editedArguments?: { readonly [key: string]: JsonValue }
  readonly alternative?: ToolApprovalAlternative
  readonly askedAt?: string
  readonly commandId?: string
}

export const RunCancelTargetSchema = Schema.Struct({
  runId: Schema.optionalKey(ChatIdentifierSchema),
  sessionId: Schema.optionalKey(ChatIdentifierSchema),
  holdQueue: Schema.optionalKey(Schema.Boolean)
}).check(
  Schema.makeFilter((input) => {
    const hasRun = input.runId !== undefined
    const hasSession = input.sessionId !== undefined
    if (hasRun === hasSession) return "requires exactly one of runId or sessionId"
    return input.holdQueue === true && !hasSession ? "holdQueue needs a sessionId" : undefined
  })
)
