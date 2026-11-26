import { PauseRequested, ToolExecutionError } from "@arden-hq/loop"
import { Schema } from "effect"

import type { NestedCallFacts } from "./contract.js"
import {
  isJsonObject,
  PREVIEW_CHARS,
  resultPreview,
  trimmedArgs,
  type ScriptProgressTool
} from "./nested-trace.js"
import { errorMessage } from "@arden-hq/std/errors"
import { type ScriptRun, MAX_TOOL_CALLS, toolFailure } from "./script-run.js"

export const runScriptTool = (
  run: ScriptRun,
  request: Readonly<Record<string, Schema.Json>>,
  signal: AbortSignal
): Promise<Schema.Json> => {
  const {
    options,
    toolCalls,
    nestedCallId,
    progressTools,
    emitProgress,
    inGroup,
    limitTools,
    unreported,
    halted,
    halt
  } = run
  const name = request["name"]
  const args = request["args"]
  const phase = request["phase"]
  if (typeof name !== "string" || name.length === 0) {
    return Promise.resolve(toolFailure("Tool name must not be empty"))
  }
  if (!isJsonObject(args)) {
    return Promise.resolve(toolFailure("Tool arguments must be a JSON object"))
  }
  if (toolCalls.length >= MAX_TOOL_CALLS) {
    return Promise.resolve(toolFailure(`Code Mode allows at most ${MAX_TOOL_CALLS} tool calls`))
  }
  const toolCallId = nestedCallId(name, args)
  let entry: ScriptProgressTool = {
    phase_id: typeof request["phase_id"] === "string" ? request["phase_id"] : null,
    tool_call_id: toolCallId,
    name,
    phase: typeof phase === "string" ? phase : null,
    status: "running",
    changes_state: options.changesState?.(name) ?? false,
    args: trimmedArgs(args),
    preview: null
  } satisfies ScriptProgressTool
  let recorded: NestedCallFacts = {}
  toolCalls.push(name)
  progressTools.set(toolCallId, entry)
  emitProgress()
  return inGroup(
    options.concurrencyGroup?.(name) ?? null,
    { write: entry.changes_state, signal },
    () =>
      limitTools(() =>
        options.tool({
          onResolved: (resolvedId) => {
            entry = { ...entry, tool_call_id: resolvedId }
            progressTools.set(toolCallId, entry)
            emitProgress()
          },
          onSettled: (facts) => {
            recorded = facts
          },
          parentToolCallId: options.parentToolCallId,
          toolCallId,
          name,
          args,
          ...(entry.phase === null ? {} : { phase: entry.phase }),
          signal
        })
      )
  ).then(
    (value) => {
      progressTools.set(toolCallId, {
        ...entry,
        ...recorded,
        status: "completed",
        preview: resultPreview(value)
      })
      unreported.add(entry.tool_call_id)
      emitProgress()
      return { kind: "script_tool_result", status: "succeeded", value } as const
    },
    (cause: unknown) => {
      progressTools.set(toolCallId, {
        ...entry,
        ...recorded,
        status: "failed",
        preview: cause instanceof Error ? cause.message.slice(0, PREVIEW_CHARS) : null
      })
      unreported.add(entry.tool_call_id)
      emitProgress()
      if (cause instanceof PauseRequested) {
        halted.value ??= cause
        halt.abort(cause)
      }
      return toolFailure(
        errorMessage(cause, "Tool call failed"),
        cause instanceof ToolExecutionError ? cause.preview : undefined
      )
    }
  )
}
