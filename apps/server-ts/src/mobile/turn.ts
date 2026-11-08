import { clipLine, cutText } from "@arden-hq/std/text"
import type { HistoryMessage, HistoryToolCall, TurnShell } from "@arden-hq/protocol/chat"
import type { MobileTurn, MobileTurnStep } from "@arden-hq/protocol/mobile"
import {
  callDetail,
  callKindWords,
  isAskCall,
  parseCallArgs,
  runningVerb,
  turnCallsSummaryText
} from "@arden-hq/protocol/views"
import { foldLine } from "./conversation.js"

const TURN_STEP_LIMIT = 200
const DETAIL_CHARS = 140
const TITLE_CHARS = 140
const NOTE_CHARS = 600

export function turnRail({
  shell,
  conversation,
  work,
  running
}: {
  readonly shell: TurnShell
  readonly conversation: readonly HistoryMessage[]
  readonly work: readonly HistoryMessage[]
  readonly running: boolean
}): MobileTurn {
  const results = new Map(
    work.flatMap((message) =>
      message.role === "tool" && message.tool_call_id !== undefined
        ? [[message.tool_call_id, message] as const]
        : []
    )
  )
  const placed = [
    ...conversation.flatMap(notesOf),
    ...work.flatMap((message) =>
      callsOf(message).map(({ call, at }) => ({
        at,
        step: toolStep(call, results.get(call.id), running)
      }))
    )
  ].sort((left, right) => left.at.seq - right.at.seq || left.at.part - right.at.part)
  const lastCall = placed.findLastIndex((entry) => entry.step.kind === "tool")
  const steps = placed.slice(0, lastCall + 1).map((entry) => entry.step)
  const kept = steps.slice(0, TURN_STEP_LIMIT)
  const left = steps.length - kept.length
  return {
    turn_id: shell.turn_id,
    ...(running
      ? { summary: turnCallsSummaryText(shell.tool_calls ?? []) ?? "Working", seconds: null }
      : foldLine(shell)),
    steps:
      left > 0
        ? [...kept, { kind: "note", id: `${shell.turn_id}:more`, text: `… and ${left} more` }]
        : kept
  }
}

type ToolState = Extract<MobileTurnStep, { kind: "tool" }>["state"]

interface Placed {
  readonly at: { readonly seq: number; readonly part: number }
  readonly step: MobileTurnStep
}

function notesOf(message: HistoryMessage): Placed[] {
  if (message.role !== "assistant" || message.is_meta === true) return []
  return (message.output_parts ?? []).flatMap((part): Placed[] =>
    part.type === "text" && part.phase !== "final_answer" && part.text.trim() !== ""
      ? [
          {
            at: { seq: message.seq ?? 0, part: part.source_index },
            step: {
              kind: "note",
              id: `${message.message_id}:${part.source_index}`,
              text: cutText(part.text.trim(), NOTE_CHARS)
            }
          }
        ]
      : []
  )
}

function callsOf(
  message: HistoryMessage
): { readonly call: HistoryToolCall; readonly at: Placed["at"] }[] {
  if (message.role !== "assistant") return []
  const calls = (message.tool_calls ?? []).filter((call) => !isAskCall(call.name))
  const seq = message.seq ?? 0
  const parts = message.output_parts
  if (parts === undefined) return calls.map((call, index) => ({ call, at: { seq, part: index } }))
  return parts.flatMap((part) => {
    if (part.type !== "tool_call") return []
    const call = calls.find(
      (candidate) =>
        candidate.id === part.tool_call_id && (candidate.execution ?? "runtime") === part.execution
    )
    return call === undefined ? [] : [{ call, at: { seq, part: part.source_index } }]
  })
}

function toolStep(
  call: HistoryToolCall,
  result: HistoryMessage | undefined,
  running: boolean
): MobileTurnStep {
  const words = {
    name: call.name,
    displayName: call.display_name,
    args: parseCallArgs(call.arguments),
    icon: call.icon,
    noun: call.noun
  }
  const state = callState(call, result, running)
  const verb = callKindWords(words).verb
  const title = state === "running" ? runningVerb(call.display_title?.trim() || verb) : verb
  return {
    kind: "tool",
    id: call.id,
    title: clipLine(title, TITLE_CHARS),
    detail: callDetail(words, DETAIL_CHARS),
    state,
    seconds:
      state === "running" || call.duration_ms === undefined
        ? null
        : Math.round(call.duration_ms / 1000)
  }
}

function callState(
  call: HistoryToolCall,
  result: HistoryMessage | undefined,
  running: boolean
): ToolState {
  const resultError = result?.role === "tool" ? result.is_error : undefined
  const outcome = (result?.role === "tool" ? result.outcome : undefined) ?? call.outcome
  if (
    resultError === true ||
    (resultError === undefined && call.is_error === true) ||
    outcome?.status === "failed" ||
    outcome?.status === "denied"
  )
    return "failed"
  if (result !== undefined || call.result !== undefined || call.execution === "provider")
    return "done"
  return running ? "running" : "failed"
}
