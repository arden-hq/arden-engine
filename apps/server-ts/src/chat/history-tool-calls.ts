import {
  toolKindOf,
  GMAIL_SEND,
  TOOL_CALL_RESULT,
  TOOL_CALL_STARTED,
  TOOL_CALL_STATUS,
  TOOL_DATA,
  TOOL_DURATION,
  TOOL_EXECUTION,
  TOOL_ICON,
  TOOL_NOUN,
  TOOL_PARENT,
  TOOL_PRESENTATION,
  TOOL_SOURCE,
  TOOL_TITLE,
  toolRetry,
  type GmailSend,
  type HistoryToolCall,
  type ToolCallStatus,
  type ToolExecution,
  type ToolFace
} from "@arden-hq/protocol/chat"
import { GmailSendReceiptSchema } from "@arden-hq/protocol/effect/chat"
import { Option, Predicate, Schema } from "effect"
import type { ToolExecutionResultMetadata } from "../persistence/tools/history-queries.js"

type StoredCall = Readonly<Record<string, unknown>>

const GMAIL_SEND_TOOLS: ReadonlySet<string> = new Set([
  "email_send",
  "email_reply",
  "email_forward"
])

const decodeGmailSendReceipt = Schema.decodeUnknownOption(GmailSendReceiptSchema)

const text = (value: unknown): string | undefined =>
  Predicate.isString(value) && value.length > 0 ? value : undefined

const storedFace = (call: StoredCall, name: string, execution: ToolExecution): ToolFace => {
  const parent = text(call.parent_id)
  const title = text(call.display_title)
  const icon = text(call.icon)
  const noun = text(call.noun)
  const source = text(call.source)
  return {
    parent:
      parent === undefined
        ? { kind: TOOL_PARENT.root }
        : { kind: TOOL_PARENT.child, parent_id: parent },
    display_name: text(call.display_name) ?? name,
    title:
      title === undefined
        ? { kind: TOOL_TITLE.untitled }
        : { kind: TOOL_TITLE.titled, text: title },
    kind: toolKindOf(call.kind),
    icon: icon === undefined ? { kind: TOOL_ICON.plain } : { kind: TOOL_ICON.icon, name: icon },
    noun: noun === undefined ? { kind: TOOL_NOUN.unnamed } : { kind: TOOL_NOUN.noun, text: noun },
    source:
      source === undefined
        ? { kind: TOOL_SOURCE.unsourced }
        : { kind: TOOL_SOURCE.source, name: source },
    presentation:
      call.presentation === TOOL_PRESENTATION.conversation ||
      call.presentation === TOOL_PRESENTATION.status
        ? call.presentation
        : TOOL_PRESENTATION.work,
    execution
  }
}

const storedStatus = (call: StoredCall): ToolCallStatus =>
  Predicate.isBoolean(call.is_error)
    ? {
        kind: TOOL_CALL_STATUS.settled,
        is_error: call.is_error,
        retry: toolRetry(Predicate.isBoolean(call.retryable) ? call.retryable : null),
        duration: { kind: TOOL_DURATION.untimed }
      }
    : { kind: TOOL_CALL_STATUS.open }

const storedCall = (
  call: StoredCall,
  identity: { readonly id: string; readonly name: string; readonly arguments: unknown },
  execution: ToolExecution
): HistoryToolCall => ({
  id: identity.id,
  name: identity.name,
  arguments: Predicate.isString(identity.arguments)
    ? identity.arguments
    : JSON.stringify(identity.arguments ?? {}),
  ...storedFace(call, identity.name, execution),
  started: Predicate.isNumber(call.started_at)
    ? { kind: TOOL_CALL_STARTED.at, at: call.started_at }
    : { kind: TOOL_CALL_STARTED.unrecorded },
  result: Predicate.isString(call.result)
    ? { kind: TOOL_CALL_RESULT.shown, text: call.result }
    : { kind: TOOL_CALL_RESULT.unshown },
  status: storedStatus(call),
  gmail_send: { kind: GMAIL_SEND.unconfirmed },
  data:
    execution === TOOL_EXECUTION.provider &&
    Array.isArray(call.source_refs) &&
    call.source_refs.length > 0
      ? { kind: TOOL_DATA.attached, value: { source_refs: call.source_refs } }
      : { kind: TOOL_DATA.none }
})

export const historyToolCalls = (value: unknown): ReadonlyArray<HistoryToolCall> => {
  if (!Array.isArray(value)) return []
  return value.filter(Predicate.isObject).flatMap((call) => {
    const fn = Predicate.isObject(call.function) ? call.function : undefined
    const fallbackName = fn !== undefined && Predicate.isString(fn.name) ? fn.name : undefined
    const name = Predicate.isString(call.name) ? call.name : fallbackName
    if (!Predicate.isString(call.id) || name === undefined) return []
    return [
      storedCall(
        call,
        { id: call.id, name, arguments: call.arguments ?? fn?.arguments },
        TOOL_EXECUTION.runtime
      )
    ]
  })
}

export const historyProviderToolCalls = (value: unknown): ReadonlyArray<HistoryToolCall> => {
  if (!Array.isArray(value)) return []
  return value
    .filter(Predicate.isObject)
    .flatMap((call) =>
      Predicate.isString(call.id) && Predicate.isString(call.name)
        ? [
            storedCall(
              call,
              { id: call.id, name: call.name, arguments: call.arguments },
              TOOL_EXECUTION.provider
            )
          ]
        : []
    )
}

const gmailSend = (name: string, metadata: ToolExecutionResultMetadata): GmailSend => {
  if (!GMAIL_SEND_TOOLS.has(name) || metadata.isError) return { kind: GMAIL_SEND.unconfirmed }
  const receipt = decodeGmailSendReceipt(metadata.data?.["gmail_send_receipt"])
  return Option.isSome(receipt)
    ? { kind: GMAIL_SEND.confirmed, receipt: receipt.value }
    : { kind: GMAIL_SEND.unconfirmed }
}

export const withResultMetadata = (
  call: HistoryToolCall,
  metadata: ToolExecutionResultMetadata | undefined
): HistoryToolCall =>
  metadata === undefined
    ? call
    : {
        ...call,
        status: {
          kind: TOOL_CALL_STATUS.settled,
          is_error: metadata.isError,
          retry: toolRetry(metadata.retryable),
          duration:
            metadata.durationMs === undefined
              ? { kind: TOOL_DURATION.untimed }
              : { kind: TOOL_DURATION.timed, ms: metadata.durationMs }
        },
        gmail_send: gmailSend(call.name, metadata)
      }

export const withConversationResult = (
  call: HistoryToolCall,
  result: string | undefined,
  metadata: ToolExecutionResultMetadata | undefined
): HistoryToolCall => ({
  ...call,
  ...(result === undefined ? {} : { result: { kind: TOOL_CALL_RESULT.shown, text: result } }),
  ...(metadata?.data === undefined
    ? {}
    : { data: { kind: TOOL_DATA.attached, value: metadata.data } })
})
