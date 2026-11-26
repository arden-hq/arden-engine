import type { PauseRequested } from "../errors.js"
import {
  callEndsTurn,
  type PendingToolCall,
  type ToolMeta,
  type ToolResult
} from "../contracts/tools.js"
import type { ToolCompleted, ToolPaused, ToolStarted } from "../contracts/events.js"

export interface ResolvedCall {
  readonly call: PendingToolCall
  readonly meta: ToolMeta
}

export const makeResolved = (
  call: PendingToolCall,
  metas: ReadonlyMap<string, ToolMeta>
): ResolvedCall => ({
  call,
  meta: metas.get(call.name) ?? { name: call.name }
})

const callHost = (resolved: ResolvedCall): Readonly<Record<string, unknown>> => ({
  ...(resolved.meta.host ?? {}),
  ...(resolved.call.displayTitle === undefined ? {} : { display_title: resolved.call.displayTitle })
})

export const started = (resolved: ResolvedCall, timestamp: number): ToolStarted => ({
  timestamp,
  _tag: "ToolStarted",
  depth: 0,
  parent_id: null,
  tool_id: resolved.call.toolCall.id,
  name: resolved.call.name,
  args: { ...resolved.call.args },
  host: callHost(resolved)
})

export const completed = (
  resolved: ResolvedCall,
  result: ToolResult,
  durationMs: number
): ToolCompleted => ({
  _tag: "ToolCompleted",
  depth: 0,
  parent_id: null,
  tool_id: resolved.call.toolCall.id,
  name: resolved.call.name,
  result: result.content,
  preview: result.preview,
  duration_ms: durationMs,
  is_error: result.is_error ?? false,
  data: result.data ?? null,
  retryable: result.retryable ?? null,
  message_extras: { ...(result.message_extras ?? {}) },
  host: { ...callHost(resolved), ...(result.host ?? {}) },
  model_content: result.model_content ?? [],
  ends_turn: callEndsTurn(resolved.meta, resolved.call.args)
})

export const paused = (resolved: ResolvedCall, pause: PauseRequested): ToolPaused => ({
  _tag: "ToolPaused",
  depth: 0,
  parent_id: null,
  tool_id: resolved.call.toolCall.id,
  name: resolved.call.name,
  args: { ...resolved.call.args },
  reason: pause.reason,
  detail: pause.detail ?? ""
})
