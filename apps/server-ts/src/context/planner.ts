import { Predicate } from "effect"

import type { StoredMessageEnvelope } from "../persistence/transcript/model.js"
import { ownerText } from "../persistence/transcript/owner-words.js"
import { compactAnswerBlocks } from "./answer-blocks.js"
import { readHandoff } from "./handoff.js"
import { TIME_SINCE_LAST_MESSAGE_CONTEXT } from "./idle-gap.js"

const DEFAULT_COMPACTION_KEEP_RATIO = 0.2

export interface CompactionPlan {
  readonly source: ReadonlyArray<StoredMessageEnvelope>
  readonly tail: ReadonlyArray<StoredMessageEnvelope>
  readonly sourceText: string
  readonly messageStartId: string
  readonly messageEndId: string
  readonly parentCompactionId?: string
  readonly priorSummary?: string
}

const textContent = (content: unknown): string => {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((block) => {
      if (!Predicate.isObject(block)) return []
      const value = block
      if (value.type === "text" && typeof value.text === "string") return [value.text]
      if (
        value.type === "context" &&
        value.content_type !== TIME_SINCE_LAST_MESSAGE_CONTEXT &&
        typeof value.content === "string"
      )
        return [value.content]
      if (value.type === "image") return ["[image omitted]"]
      if (value.type === "audio") return ["[audio omitted]"]
      return []
    })
    .join("\n")
    .trim()
}

interface ToolCallLine {
  readonly id: string
  readonly execution: "runtime" | "provider"
  readonly line: string
}

const toolCalls = (message: StoredMessageEnvelope): ReadonlyArray<ToolCallLine> => {
  const calls = message.tool_calls
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call) => {
    if (!Predicate.isObject(call) || !Predicate.isObject(call.function)) return []
    const value = call.function
    if (typeof value.name !== "string") return []
    if (typeof call.id !== "string") return []
    return [
      {
        id: call.id,
        execution: "runtime",
        line: `tool call ${value.name}: ${typeof value.arguments === "string" ? value.arguments : "{}"}`
      }
    ]
  })
}

const providerToolCalls = (message: StoredMessageEnvelope): ReadonlyArray<ToolCallLine> => {
  const calls = message.provider_tool_calls
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call) => {
    if (!Predicate.isObject(call)) return []
    const value = call
    if (typeof value.id !== "string" || typeof value.name !== "string") return []
    const args = value.arguments === undefined ? "{}" : JSON.stringify(value.arguments)
    const result =
      typeof value.result === "string" && value.result.length > 0 ? `\nresult: ${value.result}` : ""
    return [
      {
        id: value.id,
        execution: "provider",
        line: `provider tool ${value.name}: ${args}${result}`
      }
    ]
  })
}

const assistantBody = (message: StoredMessageEnvelope): ReadonlyArray<string> => {
  const runtimeCalls = toolCalls(message)
  const providerCalls = providerToolCalls(message)
  const ordered = orderedAssistantBody(message, runtimeCalls, providerCalls)
  if (ordered !== undefined) return ordered
  return [
    textContent(message.content),
    ...runtimeCalls.map((call) => call.line),
    ...providerCalls.map((call) => call.line)
  ]
}

const orderedAssistantBody = (
  message: StoredMessageEnvelope,
  runtimeCalls: ReadonlyArray<ToolCallLine>,
  providerCalls: ReadonlyArray<ToolCallLine>
): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(message.output_parts)) return undefined
  if (
    !hasExactStoredCallCount(message.tool_calls, runtimeCalls.length) ||
    !hasExactStoredCallCount(message.provider_tool_calls, providerCalls.length)
  )
    return undefined

  const calls = [...runtimeCalls, ...providerCalls]
  const callsByKey = new Map(calls.map((call) => [`${call.execution}:${call.id}`, call.line]))
  if (callsByKey.size !== calls.length) return undefined

  const referencedCalls = new Set<string>()
  const textParts: string[] = []
  const lines: string[] = []
  for (const part of message.output_parts) {
    if (!Predicate.isObject(part)) return undefined
    const value = part
    if (value.type === "reasoning") {
      if (typeof value.text !== "string" || value.text.length === 0) return undefined
      continue
    }
    if (value.type === "text") {
      if (
        typeof value.text !== "string" ||
        value.text.length === 0 ||
        (value.phase !== undefined &&
          value.phase !== "commentary" &&
          value.phase !== "final_answer")
      )
        return undefined
      textParts.push(value.text)
      lines.push(value.text)
      continue
    }
    if (
      value.type !== "tool_call" ||
      typeof value.tool_call_id !== "string" ||
      value.tool_call_id.length === 0 ||
      (value.execution !== "runtime" && value.execution !== "provider")
    )
      return undefined
    const key = `${value.execution}:${value.tool_call_id}`
    const line = callsByKey.get(key)
    if (line === undefined || referencedCalls.has(key)) return undefined
    referencedCalls.add(key)
    lines.push(line)
  }

  const storedText = exactAssistantText(message.content)
  if (storedText === undefined || textParts.join("") !== storedText) return undefined
  return referencedCalls.size === callsByKey.size ? lines : undefined
}

const exactAssistantText = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return ""
  return typeof value === "string" ? value : undefined
}

const hasExactStoredCallCount = (value: unknown, parsedCount: number): boolean => {
  if (value === null || value === undefined) return parsedCount === 0
  return Array.isArray(value) && value.length === parsedCount
}

const isRuntimeContext = (message: StoredMessageEnvelope): boolean => message.role === "developer"

const serializeMessage = (message: StoredMessageEnvelope): string => {
  if (isRuntimeContext(message)) return ""
  const body = (
    message.role === "assistant"
      ? assistantBody(message).map(compactAnswerBlocks)
      : [textContent(message.content)]
  )
    .filter(Boolean)
    .join("\n")
  if (body.length === 0) return ""
  const name = message.role === "tool" && typeof message.name === "string" ? ` ${message.name}` : ""
  const role = message.role === "user" && ownerText(message).length === 0 ? "context" : message.role
  return `${role}${name}: ${body}`
}

const compactionId = (message: StoredMessageEnvelope): string | undefined => {
  const value = message.compaction
  if (!Predicate.isObject(value)) return undefined
  return value.kind === "session_handoff" && typeof value.compaction_id === "string"
    ? value.compaction_id
    : undefined
}

const priorHandoff = (
  message: StoredMessageEnvelope
): ReturnType<typeof readHandoff> | undefined =>
  compactionId(message) === undefined ? undefined : readHandoff(textContent(message.content))

const chooseTurnBoundary = (
  starts: ReadonlyArray<number>,
  tailSize: (start: number) => number,
  targetTailSize: number
): number | undefined => {
  let index = starts.length - 1
  while (index > 0 && tailSize(starts[index] ?? 0) < targetTailSize) index -= 1
  return starts[index]
}

const isToolContinuation = (message: StoredMessageEnvelope): boolean =>
  message.role === "tool" || (message.role === "user" && message.is_meta === true)

const earliestLaunch = (
  messages: ReadonlyArray<StoredMessageEnvelope>,
  callIds: ReadonlySet<string>
): number | undefined => {
  if (callIds.size === 0) return undefined
  const index = messages.findIndex(
    (message) =>
      message.role === "assistant" && toolCalls(message).some((call) => callIds.has(call.id))
  )
  return index < 0 ? undefined : index
}

const CALL_CLIENT_ID = /^(?:async-result|tool-media):(.+)$/

const referencedCallIds = (message: StoredMessageEnvelope): ReadonlyArray<string> => {
  const launch = message.async_tool_launch
  const client =
    typeof message.client_id === "string" ? CALL_CLIENT_ID.exec(message.client_id) : null
  return [
    ...(message.role === "tool" && typeof message.tool_call_id === "string"
      ? [message.tool_call_id]
      : []),
    ...(Predicate.isObject(launch) && typeof launch.call_id === "string" ? [launch.call_id] : []),
    ...(client?.[1] === undefined ? [] : [client[1]])
  ]
}

const openLaunches = (messages: ReadonlyArray<StoredMessageEnvelope>): ReadonlySet<string> => {
  const settled = new Set(
    messages.flatMap((message) => {
      if (message.role === "tool" && message.async_tool_launch === undefined)
        return typeof message.tool_call_id === "string" ? [message.tool_call_id] : []
      const client =
        typeof message.client_id === "string" && message.client_id.startsWith("async-result:")
          ? message.client_id.slice("async-result:".length)
          : undefined
      return client === undefined ? [] : [client]
    })
  )
  return new Set(
    messages.flatMap((message) => {
      const launch = message.async_tool_launch
      return Predicate.isObject(launch) &&
        typeof launch.call_id === "string" &&
        !settled.has(launch.call_id)
        ? [launch.call_id]
        : []
    })
  )
}

const closeToolUnits = (
  messages: ReadonlyArray<StoredMessageEnvelope>,
  tailStart: number
): number => {
  const callIndex = new Map<string, number>()
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return
    for (const call of toolCalls(message))
      if (!callIndex.has(call.id)) callIndex.set(call.id, index)
  })
  let start = tailStart
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    for (const id of referencedCallIds(message)) {
      const call = callIndex.get(id)
      if (call !== undefined && call < start) start = call
    }
  }
  return start
}

export const planCompaction = (
  messages: ReadonlyArray<StoredMessageEnvelope>,
  keepRatio = DEFAULT_COMPACTION_KEEP_RATIO,
  keepCallIds: ReadonlySet<string> = new Set()
): CompactionPlan | null => {
  if (!Number.isFinite(keepRatio) || keepRatio <= 0 || keepRatio > 1) {
    throw new RangeError("Compaction keep ratio must be greater than zero and at most one")
  }

  const tailSize = (start: number): number =>
    messages.slice(start).filter((message) => !isRuntimeContext(message)).length
  const conversationSize = tailSize(0)
  const targetTailSize = Math.max(1, Math.ceil(conversationSize * keepRatio))
  const userStarts = messages.flatMap((message, index) =>
    message.role === "user" && message.is_meta !== true ? [index] : []
  )
  const last = messages.at(-1)
  const preferredStarts =
    last?.role === "user" && last.is_meta !== true ? userStarts.slice(0, -1) : userStarts
  let tailStart = chooseTurnBoundary(preferredStarts, tailSize, targetTailSize)
  const latestTurnStart = preferredStarts.at(-1)
  const latestTurnExceedsTarget =
    tailStart !== undefined && tailStart === latestTurnStart && tailSize(tailStart) > targetTailSize

  if (tailStart === undefined || tailStart <= 1 || latestTurnExceedsTarget) {
    if (conversationSize <= 2) return null
    let start = messages.length
    while (start > 0 && tailSize(start) < targetTailSize) start -= 1
    tailStart = Math.max(2, start)
    for (
      let message = messages[tailStart];
      message !== undefined && isToolContinuation(message);
      message = messages[tailStart]
    ) {
      tailStart += 1
    }
  }
  const sizes = messages.map((message) =>
    isRuntimeContext(message) ? 0 : Buffer.byteLength(JSON.stringify(message))
  )
  const targetBytes = sizes.reduce((total, size) => total + size, 0) * keepRatio
  let tailBytes = sizes.slice(tailStart).reduce((total, size) => total + size, 0)
  for (const boundary of preferredStarts) {
    if (tailBytes <= targetBytes) break
    if (boundary <= tailStart) continue
    tailBytes -= sizes.slice(tailStart, boundary).reduce((total, size) => total + size, 0)
    tailStart = boundary
  }
  const launch = earliestLaunch(messages, new Set([...keepCallIds, ...openLaunches(messages)]))
  if (launch !== undefined) tailStart = Math.min(tailStart, launch)
  tailStart = closeToolUnits(messages, tailStart)
  if (tailStart <= 1 || tailStart > messages.length) return null

  const source = messages.slice(0, tailStart)
  const tail = messages.slice(tailStart)
  const priorIndex = source.findLastIndex((message) => compactionId(message) !== undefined)
  const prior = source[priorIndex]
  const handoff = prior === undefined ? undefined : priorHandoff(prior)
  const priorSummary = handoff === undefined || handoff.length === 0 ? undefined : handoff
  const sourceText = source
    .filter((_, index) => index !== priorIndex)
    .map(serializeMessage)
    .filter(Boolean)
    .join("\n\n")
  const first = source[0]
  const sourceLast = source.at(-1)
  if (
    first === undefined ||
    sourceLast === undefined ||
    (sourceText.length === 0 && priorSummary === undefined)
  )
    return null

  const parentCompactionId = source.reduce<string | undefined>(
    (latest, message) => compactionId(message) ?? latest,
    undefined
  )
  return {
    source,
    tail,
    sourceText,
    messageStartId: first.message_id,
    messageEndId: sourceLast.message_id,
    ...(parentCompactionId === undefined ? {} : { parentCompactionId }),
    ...(priorSummary === undefined ? {} : { priorSummary })
  }
}
