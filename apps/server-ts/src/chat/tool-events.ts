import type { AgentEvent } from "@arden-hq/loop"
import { isRecord } from "@arden-hq/std/json"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import {
  chatDecoders,
  DEFAULT_TOOL_KIND,
  GMAIL_SEND,
  TOOL_DATA,
  TOOL_EXECUTION,
  TOOL_ICON,
  TOOL_NOUN,
  TOOL_PARENT,
  TOOL_PRESENTATION,
  TOOL_SOURCE,
  TOOL_TITLE,
  toolRetry,
  type GmailSend,
  type ToolData,
  type ToolExecution,
  type ToolFace,
  type ToolPresentation
} from "@arden-hq/protocol/chat"

type ToolStarted = Extract<AgentEvent, { readonly _tag: "ToolStarted" }>
type ToolCompleted = Extract<AgentEvent, { readonly _tag: "ToolCompleted" }>
type ToolEvent<Type extends ChatProjectionEvent["type"]> = Extract<
  ChatProjectionEvent,
  { readonly type: Type }
>

type ChatEventBatchOf = ReadonlyArray<ChatProjectionEvent>

const GMAIL_SEND_TOOLS: ReadonlySet<string> = new Set([
  "email_send",
  "email_reply",
  "email_forward"
])

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const presentationOf = (value: unknown): ToolPresentation =>
  value === TOOL_PRESENTATION.conversation || value === TOOL_PRESENTATION.status
    ? value
    : TOOL_PRESENTATION.work

const toolData = (value: unknown): ToolData =>
  isRecord(value) ? { kind: TOOL_DATA.attached, value } : { kind: TOOL_DATA.none }

const gmailSend = (data: unknown): GmailSend => {
  if (!isRecord(data)) return { kind: GMAIL_SEND.unconfirmed }
  try {
    const receipt = chatDecoders.gmailSendReceipt(data["gmail_send_receipt"])
    return { kind: GMAIL_SEND.confirmed, receipt }
  } catch {
    return { kind: GMAIL_SEND.unconfirmed }
  }
}

const executionOf = (event: ToolStarted | ToolCompleted): ToolExecution =>
  event.execution ?? TOOL_EXECUTION.runtime

const toolFace = (event: ToolStarted): ToolFace => {
  const title = stringField(event.host.display_title)
  const icon = stringField(event.host.icon)
  const noun = stringField(event.host.noun)
  const source = stringField(event.host.source)
  const parent = stringField(event.parent_id)
  return {
    parent:
      parent === undefined
        ? { kind: TOOL_PARENT.root }
        : { kind: TOOL_PARENT.child, parent_id: parent },
    display_name: stringField(event.host.display_name) ?? event.name,
    title:
      title === undefined
        ? { kind: TOOL_TITLE.untitled }
        : { kind: TOOL_TITLE.titled, text: title },
    kind: stringField(event.host.kind) ?? DEFAULT_TOOL_KIND,
    icon: icon === undefined ? { kind: TOOL_ICON.plain } : { kind: TOOL_ICON.icon, name: icon },
    noun: noun === undefined ? { kind: TOOL_NOUN.unnamed } : { kind: TOOL_NOUN.noun, text: noun },
    source:
      source === undefined
        ? { kind: TOOL_SOURCE.unsourced }
        : { kind: TOOL_SOURCE.source, name: source },
    presentation: presentationOf(event.host.presentation),
    execution: executionOf(event)
  }
}

export const toolStartEvents = (event: ToolStarted): ReadonlyArray<ChatEventBatchOf> => {
  const execution = executionOf(event)
  return [
    [
      {
        type: "TOOL_CALL_START",
        tool_call_id: event.tool_id,
        tool_call_name: event.name,
        ...toolFace(event)
      }
    ],
    [
      {
        type: "TOOL_CALL_ARGS",
        tool_call_id: event.tool_id,
        delta: JSON.stringify(event.args),
        execution
      }
    ],
    [{ type: "TOOL_CALL_END", tool_call_id: event.tool_id, execution }]
  ]
}

export const toolResultEvent = (event: ToolCompleted): ToolEvent<"TOOL_CALL_RESULT"> => ({
  type: "TOOL_CALL_RESULT",
  tool_call_id: event.tool_id,
  name: event.name,
  content: event.result,
  preview: event.preview,
  display_name: stringField(event.host.display_name) ?? event.name,
  kind: stringField(event.host.kind) ?? DEFAULT_TOOL_KIND,
  is_error: event.is_error,
  retry: toolRetry(event.retryable),
  duration_ms: event.duration_ms,
  data: toolData(event.data),
  source_refs: Array.isArray(event.host.source_refs) ? event.host.source_refs : [],
  gmail_send:
    event.is_error || !GMAIL_SEND_TOOLS.has(event.name)
      ? { kind: GMAIL_SEND.unconfirmed }
      : gmailSend(event.data),
  execution: executionOf(event)
})

export const toolProgressEvent = (request: {
  readonly toolCallId: string
  readonly message: string
  readonly data?: unknown
}): ToolEvent<"TOOL_CALL_PROGRESS"> => ({
  type: "TOOL_CALL_PROGRESS",
  tool_call_id: request.toolCallId,
  message: request.message,
  data: toolData(request.data),
  execution: TOOL_EXECUTION.runtime
})

export const toolOutputEvent = (request: {
  readonly toolCallId: string
  readonly stream: "stdout" | "stderr"
  readonly delta: string
}): ToolEvent<"TOOL_CALL_OUTPUT_DELTA"> => ({
  type: "TOOL_CALL_OUTPUT_DELTA",
  tool_call_id: request.toolCallId,
  stream: request.stream,
  delta: request.delta,
  execution: TOOL_EXECUTION.runtime
})

export const toolWaitingEvent = (toolCallId: string): ToolEvent<"TOOL_CALL_WAITING"> => ({
  type: "TOOL_CALL_WAITING",
  tool_call_id: toolCallId,
  execution: TOOL_EXECUTION.runtime
})
