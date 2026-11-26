import { ROLE } from "@arden-hq/std/message-vocabulary"
import { SemanticResponseError } from "../kit/index.js"
import { isRecord } from "@arden-hq/std/json"
import { isAssistantTextPhase, type AssistantTextPhase } from "../../contracts/messages.js"

export const RESPONSE_ITEM_TYPE = {
  message: "message",
  reasoning: "reasoning",
  functionCall: "function_call",
  functionCallOutput: "function_call_output",
  webSearchCall: "web_search_call",
  toolSearchCall: "tool_search_call",
  toolSearchOutput: "tool_search_output"
} as const

export const ITEM_STATUS = {
  inProgress: "in_progress",
  completed: "completed",
  incomplete: "incomplete"
} as const
type ItemStatus = (typeof ITEM_STATUS)[keyof typeof ITEM_STATUS]

export const RESPONSE_PART_TYPE = {
  outputText: "output_text",
  refusal: "refusal",
  summaryText: "summary_text",
  reasoningText: "reasoning_text"
} as const

export const TOOL_SEARCH_EXECUTION = { server: "server", client: "client" } as const

export const RESPONSE_EVENT_TYPE = {
  created: "response.created",
  outputTextDelta: "response.output_text.delta",
  refusalDelta: "response.refusal.delta",
  reasoningSummaryTextDelta: "response.reasoning_summary_text.delta",
  reasoningTextDelta: "response.reasoning_text.delta",
  outputItemAdded: "response.output_item.added",
  outputItemDone: "response.output_item.done",
  functionCallArgumentsDelta: "response.function_call_arguments.delta",
  functionCallArgumentsDone: "response.function_call_arguments.done",
  completed: "response.completed",
  incomplete: "response.incomplete",
  failed: "response.failed",
  done: "response.done",
  steerAccepted: "response.steer.accepted",
  steerFailed: "response.steer.failed",
  steerPending: "response.steer.pending",
  error: "error"
} as const
type ResponseEventType = (typeof RESPONSE_EVENT_TYPE)[keyof typeof RESPONSE_EVENT_TYPE]
const RESPONSE_EVENT_TYPES: ReadonlySet<unknown> = new Set(Object.values(RESPONSE_EVENT_TYPE))
export const isResponseEventType = (value: unknown): value is ResponseEventType =>
  RESPONSE_EVENT_TYPES.has(value)

export const INCOMPLETE_REASON = {
  maxOutputTokens: "max_output_tokens",
  contentFilter: "content_filter",
  steered: "steered"
} as const
type IncompleteReason = (typeof INCOMPLETE_REASON)[keyof typeof INCOMPLETE_REASON]
const INCOMPLETE_REASONS: ReadonlySet<unknown> = new Set(Object.values(INCOMPLETE_REASON))
const isIncompleteReason = (value: unknown): value is IncompleteReason =>
  INCOMPLETE_REASONS.has(value)

interface OutputTextPart {
  readonly type: typeof RESPONSE_PART_TYPE.outputText
  readonly text: string
  readonly annotations: ReadonlyArray<unknown>
  readonly logprobs: ReadonlyArray<unknown>
}

interface RefusalPart {
  readonly type: typeof RESPONSE_PART_TYPE.refusal
  readonly refusal: string
}

interface SummaryPart {
  readonly type: typeof RESPONSE_PART_TYPE.summaryText
  readonly text: string
}

interface ReasoningTextPart {
  readonly type: typeof RESPONSE_PART_TYPE.reasoningText
  readonly text: string
}

interface MessageOutputItem {
  readonly id: string
  readonly type: typeof RESPONSE_ITEM_TYPE.message
  readonly role: typeof ROLE.assistant
  readonly content: ReadonlyArray<OutputTextPart | RefusalPart>
  readonly status: ItemStatus
  readonly phase?: AssistantTextPhase | null
}

export interface ReasoningOutputItem {
  readonly type: typeof RESPONSE_ITEM_TYPE.reasoning
  readonly id: string
  readonly encrypted_content?: string | null
  readonly summary: ReadonlyArray<SummaryPart>
  readonly content?: ReadonlyArray<ReasoningTextPart>
  readonly status: ItemStatus
}

interface FunctionCallOutputItem {
  readonly async?: boolean
  readonly id?: string
  readonly type: typeof RESPONSE_ITEM_TYPE.functionCall
  readonly call_id: string
  readonly name: string
  readonly namespace?: string
  readonly arguments: string
  readonly status: ItemStatus
}

export interface ToolSearchCallOutputItem {
  readonly id: string
  readonly type: typeof RESPONSE_ITEM_TYPE.toolSearchCall
  readonly call_id: string | null
  readonly execution: string
  readonly arguments: unknown
  readonly status: ItemStatus
}

export interface WebSearchOutputItem {
  readonly [key: string]: unknown
  readonly id: string
  readonly type: typeof RESPONSE_ITEM_TYPE.webSearchCall
  readonly status: ItemStatus
  readonly action?: Readonly<Record<string, unknown>>
}

export type OutputItem =
  | MessageOutputItem
  | ReasoningOutputItem
  | FunctionCallOutputItem
  | WebSearchOutputItem
  | ToolSearchCallOutputItem

export interface ToolSearchCallInputItem {
  readonly [key: string]: unknown
  readonly type: typeof RESPONSE_ITEM_TYPE.toolSearchCall
  readonly call_id: string | null
  readonly execution: string
  readonly arguments: unknown
}

export interface ToolSearchOutputInputItem {
  readonly [key: string]: unknown
  readonly type: typeof RESPONSE_ITEM_TYPE.toolSearchOutput
  readonly call_id: string | null
  readonly status: string
  readonly execution: string
  readonly tools: ReadonlyArray<unknown>
}

export type StoredResponseItem = OutputItem | ToolSearchCallInputItem | ToolSearchOutputInputItem

export type InputItem = Readonly<Record<string, unknown>>

export interface ResponseUsage {
  readonly input_tokens: number
  readonly input_tokens_details: {
    readonly cached_tokens: number
    readonly cache_write_tokens: number
  }
  readonly output_tokens: number
  readonly cost: number | undefined
}

export interface ResponseShape {
  readonly output: ReadonlyArray<OutputItem>
  readonly usage: ResponseUsage | null
}

export type RawResponseEvent = Readonly<Record<string, unknown>>

export const WEB_SEARCH_TOOL_NAME = "web_search"
export const PROVIDER_STATE_KEY = "openai-responses"
export const API = "openai-responses"

export const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  isRecord(value) ? value : null

export const incompleteReason = (event: RawResponseEvent | undefined): IncompleteReason | null => {
  const reason = asRecord(asRecord(event?.response)?.incomplete_details)?.reason
  return isIncompleteReason(reason) ? reason : null
}

export const stringValue = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const itemStatus = (value: unknown): ItemStatus =>
  value === ITEM_STATUS.inProgress || value === ITEM_STATUS.incomplete
    ? value
    : ITEM_STATUS.completed

export const normalizeOutputItem = (value: unknown, fallbackId: string): OutputItem => {
  const raw = asRecord(value)
  const type = raw === null ? null : stringValue(raw.type)
  if (raw !== null && type === RESPONSE_ITEM_TYPE.message && Array.isArray(raw.content)) {
    const phase = raw.phase
    if (phase !== undefined && phase !== null && !isAssistantTextPhase(phase)) {
      throw new SemanticResponseError("OpenAI returned an invalid message phase")
    }
    const content = raw.content.map((partValue): OutputTextPart | RefusalPart => {
      const part = asRecord(partValue)
      if (part?.type === RESPONSE_PART_TYPE.outputText && typeof part.text === "string") {
        return {
          type: "output_text",
          text: part.text,
          annotations: Array.isArray(part.annotations) ? part.annotations : [],
          logprobs: Array.isArray(part.logprobs) ? part.logprobs : []
        }
      }
      if (part?.type === RESPONSE_PART_TYPE.refusal && typeof part.refusal === "string") {
        return { type: "refusal", refusal: part.refusal }
      }
      throw new SemanticResponseError("OpenAI returned invalid message content")
    })
    return {
      id: stringValue(raw.id) ?? fallbackId,
      type: "message",
      role: ROLE.assistant,
      content,
      status: itemStatus(raw.status),
      ...(phase === undefined ? {} : { phase })
    }
  }
  if (raw !== null && type === RESPONSE_ITEM_TYPE.reasoning) {
    const summary = Array.isArray(raw.summary)
      ? raw.summary.map((partValue): SummaryPart => {
          const part = asRecord(partValue)
          if (part?.type !== RESPONSE_PART_TYPE.summaryText || typeof part.text !== "string") {
            throw new SemanticResponseError("OpenAI returned invalid reasoning summary content")
          }
          return { type: "summary_text", text: part.text }
        })
      : []
    const content = Array.isArray(raw.content)
      ? raw.content.map((partValue): ReasoningTextPart => {
          const part = asRecord(partValue)
          if (part?.type !== RESPONSE_PART_TYPE.reasoningText || typeof part.text !== "string") {
            throw new SemanticResponseError("OpenAI returned invalid reasoning content")
          }
          return { type: "reasoning_text", text: part.text }
        })
      : undefined
    return {
      type: "reasoning",
      id: stringValue(raw.id) ?? fallbackId,
      ...(typeof raw.encrypted_content === "string" || raw.encrypted_content === null
        ? { encrypted_content: raw.encrypted_content }
        : {}),
      summary,
      ...(content === undefined ? {} : { content }),
      status: itemStatus(raw.status)
    }
  }
  if (
    raw !== null &&
    type === RESPONSE_ITEM_TYPE.functionCall &&
    typeof raw.call_id === "string" &&
    typeof raw.name === "string" &&
    typeof raw.arguments === "string"
  ) {
    return {
      ...(typeof raw.id === "string" ? { id: raw.id } : {}),
      type: "function_call",
      call_id: raw.call_id,
      name: raw.name,
      ...(typeof raw.namespace === "string" ? { namespace: raw.namespace } : {}),
      arguments: raw.arguments,
      ...(raw.async === true ? { async: true } : {}),
      status: itemStatus(raw.status)
    }
  }
  if (
    raw !== null &&
    type === RESPONSE_ITEM_TYPE.toolSearchCall &&
    typeof raw.execution === "string" &&
    (typeof raw.call_id === "string" || raw.call_id === null || raw.call_id === undefined)
  ) {
    return {
      id: stringValue(raw.id) ?? fallbackId,
      type: "tool_search_call",
      call_id: stringValue(raw.call_id),
      execution: raw.execution,
      arguments: raw.arguments ?? {},
      status: itemStatus(raw.status)
    }
  }
  if (raw !== null && type === RESPONSE_ITEM_TYPE.webSearchCall) {
    if (raw.action !== undefined && asRecord(raw.action) === null) {
      throw new SemanticResponseError("OpenAI returned an invalid web search action")
    }
    return {
      ...raw,
      id: stringValue(raw.id) ?? fallbackId,
      type: "web_search_call",
      status: itemStatus(raw.status),
      ...(raw.action === undefined ? {} : { action: raw.action as Record<string, unknown> })
    }
  }
  if (type !== null) {
    throw new SemanticResponseError(
      `OpenAI returned unsupported output item: ${type.slice(0, 128)}`
    )
  }
  throw new SemanticResponseError("OpenAI returned an invalid output item")
}

const partText = (part: OutputTextPart | RefusalPart): string =>
  part.type === RESPONSE_PART_TYPE.outputText ? part.text : part.refusal

export const messageItemText = (item: MessageOutputItem): string =>
  item.content.map(partText).join("")
