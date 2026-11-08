import { SemanticResponseError } from "../kit/index.js"
import { isRecord } from "@arden-hq/std/json"

export const SYNTHETIC_OUTPUT_ID_PREFIX = "arden-synthetic-output-"

type ItemStatus = "in_progress" | "completed" | "incomplete"
type MessagePhase = "commentary" | "final_answer"

interface OutputTextPart {
  readonly type: "output_text"
  readonly text: string
  readonly annotations: ReadonlyArray<unknown>
  readonly logprobs: ReadonlyArray<unknown>
}

interface RefusalPart {
  readonly type: "refusal"
  readonly refusal: string
}

interface SummaryPart {
  readonly type: "summary_text"
  readonly text: string
}

interface ReasoningTextPart {
  readonly type: "reasoning_text"
  readonly text: string
}

interface MessageOutputItem {
  readonly id: string
  readonly type: "message"
  readonly role: "assistant"
  readonly content: ReadonlyArray<OutputTextPart | RefusalPart>
  readonly status: ItemStatus
  readonly phase?: MessagePhase | null
}

export interface ReasoningOutputItem {
  readonly type: "reasoning"
  readonly id: string
  readonly encrypted_content?: string | null
  readonly summary: ReadonlyArray<SummaryPart>
  readonly content?: ReadonlyArray<ReasoningTextPart>
  readonly status: ItemStatus
}

interface FunctionCallOutputItem {
  readonly async?: boolean
  readonly id?: string
  readonly type: "function_call"
  readonly call_id: string
  readonly name: string
  /** Set when the called tool was loaded through tool search inside a namespace. */
  readonly namespace?: string
  readonly arguments: string
  readonly status: ItemStatus
}

/** The model asking the client to search deferred tools; the response ends here. */
export interface ToolSearchCallOutputItem {
  readonly id: string
  readonly type: "tool_search_call"
  readonly call_id: string | null
  readonly execution: string
  readonly arguments: unknown
  readonly status: ItemStatus
}

export interface WebSearchOutputItem {
  readonly [key: string]: unknown
  readonly id: string
  readonly type: "web_search_call"
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
  readonly type: "tool_search_call"
  readonly call_id: string | null
  readonly execution: string
  readonly arguments: unknown
}

export interface ToolSearchOutputInputItem {
  readonly [key: string]: unknown
  readonly type: "tool_search_output"
  readonly call_id: string | null
  readonly status: string
  readonly execution: string
  readonly tools: ReadonlyArray<unknown>
}

export type StoredResponseItem = OutputItem | ToolSearchCallInputItem | ToolSearchOutputInputItem

/** Wire-format input entries; kept structurally open like the wire itself. */
export type InputItem = Readonly<Record<string, unknown>>

export interface ResponseUsage {
  readonly input_tokens: number
  readonly input_tokens_details: {
    readonly cached_tokens: number
    readonly cache_write_tokens: number
  }
  readonly output_tokens: number
}

export interface ResponseShape {
  readonly output: ReadonlyArray<OutputItem>
  readonly usage: ResponseUsage | null
}

export type RawResponseEvent = Readonly<Record<string, unknown>>

export const WEB_SEARCH_TOOL_NAME = "web_search"
export const TOOL_SEARCH_TOOL_NAME = "tool_search"
/** This provider's key in an assistant message's `provider_state`. */
export const PROVIDER_STATE_KEY = "openai-responses"

export const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  isRecord(value) ? value : null

export const stringValue = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const itemStatus = (value: unknown): ItemStatus =>
  value === "in_progress" || value === "incomplete" ? value : "completed"

export const normalizeOutputItem = (value: unknown, fallbackId: string): OutputItem => {
  const raw = asRecord(value)
  const type = raw === null ? null : stringValue(raw.type)
  if (raw !== null && type === "message" && Array.isArray(raw.content)) {
    const phase = raw.phase
    if (
      phase !== undefined &&
      phase !== null &&
      phase !== "commentary" &&
      phase !== "final_answer"
    ) {
      throw new SemanticResponseError("OpenAI returned an invalid message phase")
    }
    const content = raw.content.map((partValue): OutputTextPart | RefusalPart => {
      const part = asRecord(partValue)
      if (part?.type === "output_text" && typeof part.text === "string") {
        return {
          type: "output_text",
          text: part.text,
          annotations: Array.isArray(part.annotations) ? part.annotations : [],
          logprobs: Array.isArray(part.logprobs) ? part.logprobs : []
        }
      }
      if (part?.type === "refusal" && typeof part.refusal === "string") {
        return { type: "refusal", refusal: part.refusal }
      }
      throw new SemanticResponseError("OpenAI returned invalid message content")
    })
    return {
      id: stringValue(raw.id) ?? fallbackId,
      type: "message",
      role: "assistant",
      content,
      status: itemStatus(raw.status),
      ...(phase === undefined ? {} : { phase })
    }
  }
  if (raw !== null && type === "reasoning") {
    const summary = Array.isArray(raw.summary)
      ? raw.summary.map((partValue): SummaryPart => {
          const part = asRecord(partValue)
          if (part?.type !== "summary_text" || typeof part.text !== "string") {
            throw new SemanticResponseError("OpenAI returned invalid reasoning summary content")
          }
          return { type: "summary_text", text: part.text }
        })
      : []
    const content = Array.isArray(raw.content)
      ? raw.content.map((partValue): ReasoningTextPart => {
          const part = asRecord(partValue)
          if (part?.type !== "reasoning_text" || typeof part.text !== "string") {
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
    type === "function_call" &&
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
    type === "tool_search_call" &&
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
  if (raw !== null && type === "web_search_call") {
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
  part.type === "output_text" ? part.text : part.refusal

export const messageItemText = (item: MessageOutputItem): string =>
  item.content.map(partText).join("")
