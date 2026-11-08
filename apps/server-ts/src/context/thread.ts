import { utcStamp } from "@arden-hq/std/time"
import { Option, Schema } from "effect"
import { StoredThreadSchema } from "../persistence/sessions/thread.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import { renderPromptSection } from "../prompts/format.js"
import type { ThreadRecord } from "../persistence/focus-choices/store.js"

export const renderThreadContext = (input: unknown): string | undefined => {
  const decoded = Schema.decodeUnknownOption(StoredThreadSchema)(input)
  if (Option.isNone(decoded)) return undefined
  return renderPromptSection(
    "Thread starting context",
    JSON.stringify({ ...decoded.value, status: PROMPT_TEXT.threadStatus })
  )
}

const when = utcStamp
const link = (chat: { readonly ref: string; readonly name: string }): string =>
  `[${chat.name}](arden:session/${chat.ref})`

const threadLine = (thread: ThreadRecord): string => {
  const name = `"${thread.name}" (thread_id ${thread.threadId})`
  if (thread.side === "source")
    return thread.location === "target"
      ? `- ${name} moved to ${link(thread.target)} on ${when(thread.at)}: the user chose to continue it there. Its work happens there; answer questions about it by pointing there. If the user asks to continue it here, call thread_bring_back.`
      : `- ${name} was brought back here from ${link(thread.target)} on ${when(thread.at)}; it continues here.`
  return thread.location === "target"
    ? `- ${name} moved here from ${link(thread.source)} on ${when(thread.at)}: the user chose this chat for it. A message from that chat is the user's own message, forwarded.`
    : `- ${name} went back to ${link(thread.source)} on ${when(thread.at)}; it continues there, not here.`
}

export const renderThreadLocations = (threads: ReadonlyArray<ThreadRecord>): string | undefined =>
  threads.length === 0
    ? undefined
    : renderPromptSection("Threads between chats", threads.map(threadLine).join("\n"))
