import { answerBlockText } from "@arden-hq/answer-ui"
import {
  answerBlockLabel,
  previewLine,
  replaceAnswerBlocks,
  previewMarkup,
  splitAttachedFiles,
  withFileNames,
  type HistoryMessage,
  type HistoryResponse,
  type HistoryToolCall,
  type Interaction,
  type TurnShell
} from "@arden-hq/protocol/chat"
import type { MobileConversation, MobileConversationItem } from "@arden-hq/protocol/mobile"
import type { RunProgress } from "@arden-hq/protocol/runs"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import {
  isCommandArrival,
  isInternalWorkMessage,
  isCorrespondence,
  isSenderArrival,
  turnCallsSummaryText,
  turnHeading
} from "@arden-hq/protocol/views"

import type { JsonObject } from "../persistence/json.js"
import { addLinkKeys, ardenPlace, newLinkKeys, placeHome, type PhoneHome } from "./letter.js"

type Page = Pick<MobileConversation, "items" | "live_row" | "before" | "latest_event_seq">

export interface ConversationLookups {
  readonly sessionIds: ReadonlyMap<string, string>
  readonly taskPlaces: ReadonlyMap<string, PhoneHome>
  readonly names: ReadonlyMap<string, string>
  readonly savedBlocks?: ReadonlyMap<string, ReadonlyMap<number, JsonObject>>
}

export function conversationPage({
  history,
  progress,
  now,
  lookups = { sessionIds: new Map(), taskPlaces: new Map(), names: new Map() }
}: {
  readonly history: HistoryResponse
  readonly progress: RunProgress | undefined
  readonly now: string
  readonly lookups?: ConversationLookups
}): Page {
  const active = history.runtime.active_run
  const running = active !== null && isActiveRunStatus(active.status) ? active : undefined
  const shells = new Map((history.turn_shells ?? []).map((shell) => [shell.turn_id, shell]))
  const items: MobileConversationItem[] = []
  const folded = new Set<string>()
  const sentTo = new Map<string, Set<string>>()
  const fold = (turnId: string) => {
    if (folded.has(turnId)) return
    folded.add(turnId)
    const shell = shells.get(turnId)
    if (shell !== undefined && turnId !== running?.turn_id) items.push(...workItem(shell))
  }
  for (const message of history.messages) {
    const [first, ...rest] = messageItems(message, lookups)
    if (first !== undefined && OPENING.has(first.kind) && !folded.has(message.turn_id)) {
      items.push(first)
      fold(message.turn_id)
      items.push(...rest)
    } else {
      if (first !== undefined || shells.get(message.turn_id)?.has_tool_work === true)
        fold(message.turn_id)
      if (first !== undefined) items.push(first, ...rest)
    }
    for (const call of message.role === "assistant" ? (message.tool_calls ?? []) : []) {
      const sent = sentItem(call, lookups)
      if (sent === undefined) continue
      const seen = sentTo.get(message.turn_id) ?? new Set<string>()
      const key = sent.session_id ?? sent.title
      if (seen.has(key)) continue
      seen.add(key)
      sentTo.set(message.turn_id, seen)
      items.push(sent)
    }
  }
  return {
    items,
    live_row:
      running === undefined
        ? null
        : { text: liveText(progress), started_at: running.started_at ?? now },
    before: history.page.has_more_before ? (history.page.before ?? null) : null,
    latest_event_seq: history.runtime.latest_event_seq
  }
}

const OPENING: ReadonlySet<MobileConversationItem["kind"]> = new Set(["user", "handoff", "sender"])

export function conversationLookupKeys(history: HistoryResponse): {
  readonly refs: ReadonlyArray<string>
  readonly taskIds: ReadonlyArray<string>
  readonly sessionIds: ReadonlyArray<string>
} {
  const { refs, taskIds } = newLinkKeys()
  const sessionIds = new Set<string>()
  const linkRefs = (markdown: string) => {
    for (const match of markdown.matchAll(LINK)) addLinkKeys({ refs, taskIds }, match[2])
  }
  for (const message of history.messages) {
    if (internalWorkMessage(message)) continue
    linkRefs(message.content)
    if (message.from_chat !== undefined) sessionIds.add(message.from_chat.session_id)
    if (message.interaction?.from.type === "agent") refs.add(message.interaction.from.id)
    for (const call of message.role === "assistant" ? (message.tool_calls ?? []) : []) {
      const send = sendOf(call)
      if (send !== undefined) refs.add(send.ref)
    }
  }
  return { refs: [...refs], taskIds: [...taskIds], sessionIds: [...sessionIds] }
}

function messageItems(
  message: HistoryMessage,
  lookups: ConversationLookups
): MobileConversationItem[] {
  const at = message.created_at ?? ""
  if (message.role === "assistant") {
    if (message.is_meta === true || message.content.trim() === "") return []
    return [
      {
        kind: "reply",
        id: message.message_id,
        markdown: phoneLinks(
          answerBlocksAsText(message.content, lookups.savedBlocks?.get(message.message_id)),
          lookups
        )
      }
    ]
  }
  if (message.role !== "user" || internalWorkMessage(message)) return []
  if (message.forwarded_from !== undefined) return [userItem(message)]
  if (message.automation !== undefined) {
    return [
      {
        kind: "sender",
        id: message.message_id,
        sender: "automation",
        name: message.automation.name,
        preview: previewMarkup(message.automation.prompt) ?? "",
        body: message.automation.prompt,
        failed: false,
        session_id: null,
        at
      }
    ]
  }
  if (message.from_chat !== undefined) {
    return [
      {
        kind: "handoff",
        id: message.message_id,
        from_session_id: message.from_chat.session_id,
        from_title: lookups.names.get(message.from_chat.session_id) ?? null,
        markdown: phoneLinks(message.content, lookups),
        at
      }
    ]
  }
  const interaction = message.interaction
  if (interaction !== undefined && isSenderArrival(interaction)) {
    if (isCorrespondence(interaction)) return []
    const sender = senderOf(interaction)
    const body = interaction.content.trim() || message.content
    return [
      {
        kind: "sender",
        id: message.message_id,
        sender,
        name:
          sender === "workflow"
            ? null
            : interaction.from.display_name?.trim() || interaction.from.id,
        preview: previewMarkup(interaction.preview?.trim() || body) ?? "",
        body: phoneLinks(body, lookups),
        failed: failed(message),
        session_id:
          sender === "agent" ? (lookups.sessionIds.get(interaction.from.id) ?? null) : null,
        at
      }
    ]
  }
  if (message.is_meta === true || message.question_answer !== undefined) return []
  return [userItem(message)]
}

function userItem(message: HistoryMessage): MobileConversationItem {
  const sent = splitAttachedFiles(message.content)
  return {
    kind: "user",
    id: message.message_id,
    client_id: message.client_id ?? null,
    text: sent.text,
    photos: message.role === "user" ? (message.images?.length ?? 0) : 0,
    files: sent.files.map((file) => file.name),
    reply_to:
      message.reply_to === undefined
        ? null
        : {
            role: message.reply_to.role,
            text: previewLine(withFileNames(message.reply_to.content)) ?? message.reply_to.content
          },
    recipe: message.recipe ?? null,
    sent_from: message.sent_from ?? null
  }
}

const senderOf = (interaction: Interaction): "agent" | "workflow" | "command" => {
  if (isCommandArrival(interaction)) return "command"
  return interaction.from.type === "workflow" ? "workflow" : "agent"
}

const failed = (message: HistoryMessage): boolean => {
  const interaction = message.interaction
  return (
    interaction?.kind === "completion" &&
    interaction.outcome !== "completed" &&
    interaction.outcome !== "interrupted"
  )
}

function internalWorkMessage(message: HistoryMessage): boolean {
  return isInternalWorkMessage({
    role: message.role,
    interaction: message.interaction,
    communication: message.communication,
    update: message.update,
    agentResult: message.agent_result,
    fromChat:
      message.from_chat === undefined ? undefined : { sessionRef: message.from_chat.session_ref },
    forwardedFrom:
      message.forwarded_from === undefined
        ? undefined
        : { messageId: message.forwarded_from.message_id }
  })
}

function sendOf(call: HistoryToolCall): { ref: string; title: string } | undefined {
  if (call.name !== "session_send_message" || call.is_error === true) return undefined
  const data = call.data
  if (typeof data !== "object" || data === null) return undefined
  const ref = "session_ref" in data ? data.session_ref : undefined
  if (typeof ref !== "string" || ref === "") return undefined
  const sources = "source_refs" in data && Array.isArray(data.source_refs) ? data.source_refs : []
  const first: unknown = sources[0]
  const title =
    typeof first === "object" &&
    first !== null &&
    "title" in first &&
    typeof first.title === "string"
      ? first.title.trim()
      : ""
  return { ref, title }
}

function sentItem(
  call: HistoryToolCall,
  lookups: ConversationLookups
): (MobileConversationItem & { kind: "sent" }) | undefined {
  const send = sendOf(call)
  if (send === undefined) return undefined
  const sessionId = lookups.sessionIds.get(send.ref) ?? null
  const title =
    (sessionId === null ? undefined : lookups.names.get(sessionId)) ??
    (send.title || "another chat")
  return { kind: "sent", id: call.id, session_id: sessionId, title }
}

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g

function answerBlocksAsText(
  markdown: string,
  saved: ReadonlyMap<number, JsonObject> = new Map()
): string {
  return replaceAnswerBlocks(markdown, (body, index) => {
    const text = answerBlockText(body, saved.get(index) ?? {})
    return text.length > 0 ? text : answerBlockLabel(body)
  })
}

function phoneLinks(markdown: string, lookups: ConversationLookups): string {
  return markdown.replace(LINK, (whole, words: string, target: string) => {
    if (/^https?:/i.test(target) || /^mailto:/i.test(target)) return whole
    const place = ardenPlace(target)
    if (place === undefined) return words
    const home = placeHome(place, lookups)
    return home === undefined
      ? words
      : `[${words}](arden://${home.kind}/${encodeURIComponent(home.id)})`
  })
}

function workItem(shell: TurnShell): MobileConversationItem[] {
  return shell.has_work ? [{ kind: "work", turn_id: shell.turn_id, ...foldLine(shell) }] : []
}

export function foldLine(shell: TurnShell): { summary: string; seconds: number | null } {
  const ms = Date.parse(shell.ended_at) - Date.parse(shell.started_at)
  const duration = Number.isFinite(ms) && ms >= 0 ? ms : null
  const heading = turnHeading(
    duration,
    false,
    turnCallsSummaryText(shell.tool_calls ?? []),
    !shell.has_tool_work
  )
  return {
    summary: heading.text,
    seconds: heading.time === null || duration === null ? null : Math.round(duration / 1000)
  }
}

function liveText(progress: RunProgress | undefined): string {
  const tools = progress?.active_tools ?? []
  const titled = [...tools]
    .reverse()
    .find((tool) => tool.title !== null && tool.title.trim() !== "")
  if (titled?.title) return titled.title.trim()
  return tools.length > 0 ? "Working" : "Thinking"
}
