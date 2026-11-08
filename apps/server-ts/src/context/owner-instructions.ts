import { cutText } from "@arden-hq/std/text"
import type { ChatMessage } from "@arden-hq/loop"
import { utcStamp } from "@arden-hq/std/time"
import { Predicate } from "effect"

import { ownerText } from "../persistence/transcript/owner-words.js"

export const OWNER_INSTRUCTIONS_SOURCE = "owner_instructions"

const RECITAL_TURNS = 10
const MAX_MESSAGES = 5
const MAX_MESSAGE_CHARS = 500
const MAX_TOTAL_CHARS = 2_000

const isHandoff = (message: ChatMessage): boolean =>
  Predicate.isObject(message.compaction) && message.compaction.kind === "session_handoff"

export const ownerInstructionsDue = (messages: ReadonlyArray<ChatMessage>): boolean => {
  let turns = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === "developer" && message.arden_context_source === OWNER_INSTRUCTIONS_SOURCE)
      return false
    if (isHandoff(message)) return true
    if (message.role !== "assistant") continue
    turns += 1
    if (turns >= RECITAL_TURNS) return true
  }
  return false
}

interface OwnerLine {
  readonly at: string
  readonly text: string
}

const ownerLines = (messages: ReadonlyArray<ChatMessage>): ReadonlyArray<OwnerLine> =>
  messages.flatMap((message): ReadonlyArray<OwnerLine> => {
    const text = ownerText(message).trim()
    const at = typeof message.created_at === "string" ? message.created_at : ""
    return text.length === 0 ? [] : [{ at, text }]
  })

const clipped = (text: string): string => cutText(text, MAX_MESSAGE_CHARS, { suffix: " [… cut]" })

export const renderOwnerInstructions = (
  messages: ReadonlyArray<ChatMessage>
): string | undefined => {
  const kept: OwnerLine[] = []
  let room = MAX_TOTAL_CHARS
  const lines = ownerLines(messages)
  for (let index = lines.length - 1; index >= 0 && kept.length < MAX_MESSAGES; index -= 1) {
    const line = lines[index]
    if (line === undefined) continue
    const text = clipped(line.text)
    if (text.length > room) break
    room -= text.length
    kept.unshift({ at: line.at, text })
  }
  if (kept.length === 0) return undefined
  return [
    "The user's latest messages, verbatim, newest last. They decide what you do now: they outrank the handoff summary, your todo list, and any limit, gate, cap or deadline you set for yourself. A limit you set binds only where the user stated it; approval and safety rules still apply. Where your plan differs from them, change the plan. Do not mention this note.",
    ...kept.map((line) => `- [${utcStamp(line.at)}] ${line.text}`)
  ].join("\n")
}
