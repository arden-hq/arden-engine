import type { ROLE } from "@arden-hq/std/message-vocabulary"
import type { JsonRecord } from "../common/json.js"
import type { AutomationContextMode } from "../automations/contracts.js"
import type { ChatUpdate, CommunicationEnvelope } from "./communication.js"
import type {
  AgentResult,
  AssistantTextPhase,
  ChatSentFrom,
  ConnectionArrival,
  HistoryImage,
  InteractionSender
} from "./history.js"
import type { HistoryToolCall, ToolCallStatus } from "./history-tool-call.js"
import type { ToolData, ToolExecution } from "./tool-face.js"

export const CONTEXT_TEXT = { empty: "empty", text: "text" } as const

export type ContextText =
  | { readonly kind: typeof CONTEXT_TEXT.empty }
  | { readonly kind: typeof CONTEXT_TEXT.text; readonly text: string }

export interface HistoryContextBlock extends JsonRecord {
  readonly type: "context"
  readonly content_type: string
  readonly content: ContextText
  readonly metadata: Readonly<Record<string, string>>
}

export const TEXT_PHASE = {
  unmarked: "unmarked",
  commentary: "commentary",
  finalAnswer: "final_answer"
} as const

export type OutputTextPhase = AssistantTextPhase | typeof TEXT_PHASE.unmarked

export const OUTPUT_PART = {
  reasoning: "reasoning",
  text: "text",
  toolCall: "tool_call"
} as const

export const CONTEXT_BLOCK = "context"

export type HistoryAssistantOutputPart =
  | {
      readonly type: typeof OUTPUT_PART.reasoning
      readonly text: string
      readonly source_index: number
    }
  | {
      readonly type: typeof OUTPUT_PART.text
      readonly text: string
      readonly phase: OutputTextPhase
      readonly source_index: number
    }
  | {
      readonly type: typeof OUTPUT_PART.toolCall
      readonly tool_call_id: string
      readonly execution: ToolExecution
      readonly source_index: number
    }

export const MESSAGE_CLIENT = { untracked: "untracked", tracked: "tracked" } as const

export type MessageClient =
  | { readonly kind: typeof MESSAGE_CLIENT.untracked }
  | { readonly kind: typeof MESSAGE_CLIENT.tracked; readonly client_id: string }

export const STEER_STAMP = { unstamped: "unstamped", stamped: "stamped" } as const

export type SteerStamp =
  | { readonly kind: typeof STEER_STAMP.unstamped }
  | { readonly kind: typeof STEER_STAMP.stamped; readonly at: string }

export interface QuotedMessage extends JsonRecord {
  readonly message_id: string
  readonly role: typeof ROLE.user | typeof ROLE.assistant
  readonly content: string
}

export const QUESTION_ANSWER_ROW = { none: "none", answer: "answer" } as const

export type QuestionAnswerRow =
  | { readonly kind: typeof QUESTION_ANSWER_ROW.none }
  | { readonly kind: typeof QUESTION_ANSWER_ROW.answer; readonly question_id: string }

export const SENT_FROM = { typed: "typed", surface: "surface" } as const

export type SentFrom =
  | { readonly kind: typeof SENT_FROM.typed }
  | { readonly kind: typeof SENT_FROM.surface; readonly surface: ChatSentFrom }

export const FORWARDED_FROM = { original: "original", forwarded: "forwarded" } as const

export type ForwardedFrom =
  | { readonly kind: typeof FORWARDED_FROM.original }
  | {
      readonly kind: typeof FORWARDED_FROM.forwarded
      readonly session_id: string
      readonly session_ref: string
      readonly message_id: string
    }

export const FROM_CHAT = { direct: "direct", handedOver: "handed_over" } as const

export type FromChat =
  | { readonly kind: typeof FROM_CHAT.direct }
  | {
      readonly kind: typeof FROM_CHAT.handedOver
      readonly session_id: string
      readonly session_ref: string
    }

export const CONNECTION_ROW = { none: "none", answered: "answered" } as const

export type ConnectionRow =
  | { readonly kind: typeof CONNECTION_ROW.none }
  | { readonly kind: typeof CONNECTION_ROW.answered; readonly arrival: ConnectionArrival }

export const COMMUNICATION_ROW = { none: "none", letter: "letter" } as const

export type CommunicationRow =
  | { readonly kind: typeof COMMUNICATION_ROW.none }
  | { readonly kind: typeof COMMUNICATION_ROW.letter; readonly envelope: CommunicationEnvelope }

export const UPDATE_ROW = { none: "none", update: "update" } as const

export type UpdateRow =
  | { readonly kind: typeof UPDATE_ROW.none }
  | { readonly kind: typeof UPDATE_ROW.update; readonly update: ChatUpdate }

export const AGENT_RESULT_ROW = { none: "none", report: "report" } as const

export type AgentResultRow =
  | { readonly kind: typeof AGENT_RESULT_ROW.none }
  | { readonly kind: typeof AGENT_RESULT_ROW.report; readonly result: AgentResult }

export const AUTOMATION_ROW = { none: "none", automation: "automation" } as const

export type AutomationRow =
  | { readonly kind: typeof AUTOMATION_ROW.none }
  | {
      readonly kind: typeof AUTOMATION_ROW.automation
      readonly task_id: string
      readonly name: string
      readonly prompt: string
      readonly context_mode: AutomationContextMode
    }

export const REASONING_ROW = { none: "none", reasoned: "reasoned" } as const

export type ReasoningRow =
  | { readonly kind: typeof REASONING_ROW.none }
  | { readonly kind: typeof REASONING_ROW.reasoned; readonly text: string }

interface HistoryMessageBase extends JsonRecord {
  readonly message_id: string
  readonly turn_id: string
  readonly content: string
  readonly seq: number
  readonly created_at: string
  readonly client: MessageClient
  readonly applied: SteerStamp
  readonly context: ReadonlyArray<HistoryContextBlock>
  readonly reply_to: ReadonlyArray<QuotedMessage>
  readonly compact: boolean
}

export interface HistoryUserMessage extends HistoryMessageBase {
  readonly role: typeof ROLE.user
  readonly images: ReadonlyArray<HistoryImage>
  readonly question_answer: QuestionAnswerRow
  readonly sent_from: SentFrom
  readonly forwarded_from: ForwardedFrom
}

export type HistoryInteractionMessage = HistoryMessageBase &
  InteractionSender & {
    readonly role: typeof ROLE.interaction
    readonly forwarded_from: ForwardedFrom
    readonly from_chat: FromChat
    readonly connection: ConnectionRow
    readonly communication: CommunicationRow
    readonly update: UpdateRow
    readonly agent_result: AgentResultRow
    readonly automation: AutomationRow
  }

export interface HistoryAssistantMessage extends HistoryMessageBase {
  readonly role: typeof ROLE.assistant
  readonly tool_calls: ReadonlyArray<HistoryToolCall>
  readonly output_parts: ReadonlyArray<HistoryAssistantOutputPart>
  readonly reasoning: ReasoningRow
  readonly automation: AutomationRow
}

export interface HistoryToolMessage extends HistoryMessageBase {
  readonly role: typeof ROLE.tool
  readonly tool_call_id: string
  readonly status: ToolCallStatus
  readonly data: ToolData
}

export type HistoryMessage =
  | HistoryUserMessage
  | HistoryInteractionMessage
  | HistoryAssistantMessage
  | HistoryToolMessage
