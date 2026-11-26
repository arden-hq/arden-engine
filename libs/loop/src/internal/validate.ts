import { INTERACTION_KIND, INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
import { ProtocolContractError } from "../errors.js"
import {
  ASSISTANT_OUTPUT_PART_TYPE,
  INTERACTION_KINDS,
  INTERACTION_OUTCOMES,
  INTERACTION_SOURCES,
  isAssistantTextPhase,
  isToolExecution,
  TOOL_CALL_TYPE,
  type AssistantOutputPart,
  type ChatMessage,
  type ContentBlock,
  type MessageOrigin
} from "../contracts/messages.js"
import type { ToolResult } from "../contracts/tools.js"
import { isRecord } from "@arden-hq/std/json"

// A never-returning call narrows only when its name has an explicit type: https://github.com/microsoft/TypeScript/pull/32695
const fail: (subject: string, detail: string) => never = (subject, detail) => {
  throw new ProtocolContractError(subject, new TypeError(detail))
}

const checkMessageId = (message: Record<string, unknown>): void => {
  if (
    "message_id" in message &&
    (typeof message.message_id !== "string" || message.message_id.length === 0)
  ) {
    fail("messages", "message_id must be a non-empty string")
  }
}

const isBlockArray = (value: unknown): boolean => Array.isArray(value) && value.every(isRecord)

export const isMessageOrigin = (value: unknown): value is MessageOrigin =>
  isRecord(value) &&
  typeof value.provider === "string" &&
  typeof value.api === "string" &&
  typeof value.model === "string" &&
  typeof value.requested_model === "string"

const isOneOf = <T extends string>(values: ReadonlyArray<T>, value: unknown): value is T =>
  values.some((candidate) => candidate === value)

const checkInteraction = (message: Record<string, unknown>): void => {
  const { from, to } = message
  if (
    !isRecord(from) ||
    !isOneOf(INTERACTION_SOURCES, from.source) ||
    typeof from.id !== "string" ||
    from.id.length === 0
  )
    fail("messages", "an interaction needs who it is from")
  if (
    to !== undefined &&
    (!isRecord(to) || to.source !== INTERACTION_SOURCE.agent || typeof to.id !== "string")
  )
    fail("messages", "an interaction's recipient must be an agent")
  if (typeof message.content !== "string" && !isBlockArray(message.content))
    fail("messages", "interaction content must be a string or content-block array")
  if (!isOneOf(INTERACTION_KINDS, message.kind)) fail("messages", "interaction kind is invalid")
  if (
    message.kind === INTERACTION_KIND.completion &&
    !isOneOf(INTERACTION_OUTCOMES, message.outcome)
  )
    fail("messages", "completion interaction outcome is invalid")
  const cause = message.caused_by
  if (
    cause !== undefined &&
    (!isRecord(cause) ||
      !["message", "run", "tool_call", "workflow"].includes(String(cause.type)) ||
      typeof cause.id !== "string" ||
      cause.id.length === 0)
  )
    fail("messages", "interaction reference is invalid")
}

const checkReplyContext = (value: unknown): void => {
  if (
    !isRecord(value) ||
    typeof value.messageId !== "string" ||
    value.messageId.length === 0 ||
    (value.role !== ROLE.user && value.role !== ROLE.assistant) ||
    typeof value.content !== "string"
  ) {
    fail("messages", "replyTo needs a message id, role, and content")
  }
}

const checkReplyContexts = (value: unknown): void => {
  if (!Array.isArray(value)) return checkReplyContext(value)
  if (value.length === 0) fail("messages", "replyTo needs at least one quoted message")
  value.forEach(checkReplyContext)
}

const checkToolCall = (value: unknown): void => {
  if (!isRecord(value)) fail("messages", "tool_calls entries must be objects")
  const call = value
  if (typeof call.id !== "string") fail("messages", "tool call id must be a string")
  if (call.type !== TOOL_CALL_TYPE.function) fail("messages", 'tool call type must be "function"')
  const fn = call.function
  if (!isRecord(fn) || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
    fail("messages", "tool call function must have string name and arguments")
  }
}

export const isAssistantOutputPart = (value: unknown): value is AssistantOutputPart => {
  if (!isRecord(value)) return false
  const hasText = typeof value.text === "string" && value.text.length > 0
  switch (value.type) {
    case ASSISTANT_OUTPUT_PART_TYPE.reasoning:
      return hasText
    case ASSISTANT_OUTPUT_PART_TYPE.text:
      return hasText && (value.phase === undefined || isAssistantTextPhase(value.phase))
    case ASSISTANT_OUTPUT_PART_TYPE.toolCall:
      return (
        typeof value.tool_call_id === "string" &&
        value.tool_call_id.length > 0 &&
        isToolExecution(value.execution)
      )
    default:
      return false
  }
}

const checkMessage = (value: unknown): void => {
  if (!isRecord(value)) fail("messages", "each message must be an object")
  const message = value
  checkMessageId(message)
  switch (message.role) {
    case ROLE.system:
    case ROLE.developer: {
      if (typeof message.content !== "string" && !isBlockArray(message.content)) {
        fail("messages", `${message.role} content must be a string or content-block array`)
      }
      return
    }
    case ROLE.interaction:
      return checkInteraction(message)
    case ROLE.user: {
      if ("replyTo" in message) checkReplyContexts(message.replyTo)
      if (
        "content" in message &&
        message.content !== null &&
        typeof message.content !== "string" &&
        !isBlockArray(message.content)
      ) {
        fail("messages", "user content must be a string, null, or content-block array")
      }
      return
    }
    case ROLE.assistant: {
      if (
        "content" in message &&
        message.content !== null &&
        typeof message.content !== "string" &&
        !isBlockArray(message.content)
      ) {
        fail("messages", "assistant content must be a string, null, or content-block array")
      }
      if ("tool_calls" in message) {
        if (!Array.isArray(message.tool_calls)) fail("messages", "tool_calls must be an array")
        for (const call of message.tool_calls as unknown[]) checkToolCall(call)
      }
      if (
        "reasoning_content" in message &&
        message.reasoning_content !== null &&
        typeof message.reasoning_content !== "string"
      ) {
        fail("messages", "reasoning_content must be a string or null")
      }
      if (
        "output_parts" in message &&
        (!Array.isArray(message.output_parts) || !message.output_parts.every(isAssistantOutputPart))
      ) {
        fail("messages", "output_parts must contain valid ordered assistant parts")
      }
      if ("origin" in message && !isMessageOrigin(message.origin)) {
        fail("messages", "origin must name a provider, api, model and requested_model")
      }
      return
    }
    case ROLE.tool: {
      if (typeof message.tool_call_id !== "string")
        fail("messages", "tool message needs a tool_call_id")
      if (typeof message.content !== "string")
        fail("messages", "tool message content must be a string")
      return
    }
    default:
      fail("messages", `unknown message role: ${String(message.role)}`)
  }
}

export const decodeMessage = (value: unknown): ChatMessage => {
  checkMessage(value)
  return value as ChatMessage
}

export const decodeMessages = (value: unknown): ReadonlyArray<ChatMessage> => {
  if (!Array.isArray(value)) fail("messages", "messages must be an array")
  return (value as unknown[]).map(decodeMessage)
}

export const normalizeToolResult = (value: unknown): Required<ToolResult> => {
  if (!isRecord(value)) throw new TypeError("tool result must be an object")
  const record = value
  if (typeof record.content !== "string")
    throw new TypeError("tool result content must be a string")
  if (typeof record.preview !== "string")
    throw new TypeError("tool result preview must be a string")
  const isError = record.is_error ?? false
  if (typeof isError !== "boolean") throw new TypeError("tool result is_error must be a boolean")
  const retryable = record.retryable ?? null
  if (retryable !== null && typeof retryable !== "boolean") {
    throw new TypeError("tool result retryable must be a boolean or null")
  }
  const data = record.data ?? null
  if (data !== null && !isRecord(data))
    throw new TypeError("tool result data must be an object or null")
  const extras = record.message_extras ?? {}
  if (!isRecord(extras)) throw new TypeError("tool result message_extras must be an object")
  const host = record.host ?? {}
  if (!isRecord(host)) throw new TypeError("tool result host must be an object")
  const modelContent = record.model_content ?? []
  if (!Array.isArray(modelContent) || !modelContent.every(isRecord)) {
    throw new TypeError("tool result model_content must be an array of content blocks")
  }
  return {
    content: record.content,
    preview: record.preview,
    is_error: isError,
    retryable,
    data: data as Required<ToolResult>["data"],
    message_extras: extras,
    host,
    model_content: modelContent as unknown as ReadonlyArray<ContentBlock>
  }
}
