import {
  ACTOR_NAME,
  AGENT_RESULT_ROW,
  AUTOMATION_ROW,
  COMMUNICATION_ROW,
  FORWARDED_FROM,
  FROM_CHAT,
  QUESTION_ANSWER_ROW,
  SENT_FROM,
  UPDATE_ROW,
  INTERACTION_PREVIEW,
  PAGE_BOUNDS,
  RUNTIME_RUN,
  TOOL_CALL_STATUS,
  TOOL_DATA
} from "@arden-hq/protocol/chat"
import {
  INTERACTION_KIND,
  INTERACTION_OUTCOME,
  INTERACTION_SOURCE,
  ROLE
} from "@arden-hq/std/message-vocabulary"
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
  type InteractionPreview,
  type InteractionSender
} from "@arden-hq/protocol/chat"
import {
  MOBILE_CHAT_LINK,
  type MobileChatLink,
  type MobileConversation,
  type MobileConversationItem
} from "@arden-hq/protocol/mobile"
import { TOOL_TITLE, isActiveRunStatus } from "@arden-hq/protocol/runs"
import type { RunProgressRecord } from "../persistence/runs/queries.js"
import {
  isCommandArrival,
  isInternalWorkMessage,
  isCorrespondence,
  isSenderArrival,
  VIEWED_TOOL
} from "@arden-hq/protocol/views"

import type { JsonObject } from "../persistence/json.js"
import { addLinkKeys, ardenPlace, newLinkKeys, placeHome, type PhoneHome } from "./letter.js"

type Page = Pick<MobileConversation, "items" | "live" | "before" | "latest_event_seq">

export interface ConversationLookups {
  readonly sessionIds: ReadonlyMap<string, string>
  readonly taskPlaces: ReadonlyMap<string, PhoneHome>
  readonly names: ReadonlyMap<string, string>
  readonly savedBlocks?: ReadonlyMap<string, ReadonlyMap<number, JsonObject>>
}

export function conversationPage({
  history,
  progress,
  lookups = { sessionIds: new Map(), taskPlaces: new Map(), names: new Map() }
}: {
  readonly history: HistoryResponse
  readonly progress: RunProgressRecord | undefined
  readonly lookups?: ConversationLookups
}): Page {
  const active = history.runtime.active_run
  const running =
    active.kind === RUNTIME_RUN.active && isActiveRunStatus(active.run.status)
      ? active.run
      : undefined
  const items: MobileConversationItem[] = []
  const sentTo = new Map<string, Set<string>>()
  for (const message of history.messages) {
    items.push(...messageItems(message, lookups))
    for (const call of message.role === ROLE.assistant ? message.tool_calls : []) {
      const sent = sentItem(call, lookups)
      if (sent === undefined) continue
      const seen = sentTo.get(message.turn_id) ?? new Set<string>()
      const key = sent.chat.kind === MOBILE_CHAT_LINK.linked ? sent.chat.session_id : sent.title
      if (seen.has(key)) continue
      seen.add(key)
      sentTo.set(message.turn_id, seen)
      items.push(sent)
    }
  }
  return {
    items,
    live:
      running === undefined
        ? { kind: "idle" }
        : { kind: "running", text: liveText(progress), started_at: running.started_at },
    before:
      history.page.has_more_before && history.page.bounds.kind === PAGE_BOUNDS.bounded
        ? { kind: "earlier", cursor: history.page.bounds.before }
        : { kind: "beginning" },
    latest_event_seq: history.runtime.latest_event_seq
  }
}

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
    const handoff = handoffOf(message)
    if (handoff !== undefined) sessionIds.add(handoff.session_id)
    if (message.role === ROLE.interaction && message.from.source === INTERACTION_SOURCE.agent)
      refs.add(message.from.id)
    for (const call of message.role === ROLE.assistant ? message.tool_calls : []) {
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
  const at = message.created_at
  if (message.role === ROLE.assistant) {
    if (message.content.trim() === "") return []
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
  if (internalWorkMessage(message)) return []
  if (isForwarded(message)) return [userItem(message)]
  if (message.role === ROLE.user)
    return message.question_answer.kind === QUESTION_ANSWER_ROW.none ? [userItem(message)] : []
  if (message.role !== ROLE.interaction) return []
  const automation = message.automation
  if (automation.kind === AUTOMATION_ROW.automation) {
    return [
      {
        kind: "sender",
        id: message.message_id,
        sender: { kind: "automation", name: automation.name },
        preview: previewMarkup(automation.prompt) ?? "",
        body: automation.prompt,
        failed: false,
        at
      }
    ]
  }
  const handoff = handoffOf(message)
  if (handoff !== undefined) {
    return [
      {
        kind: "handoff",
        id: message.message_id,
        from_session_id: handoff.session_id,
        from_title: titleOf(lookups.names.get(handoff.session_id)),
        markdown: phoneLinks(message.content, lookups),
        at
      }
    ]
  }
  if (!isSenderArrival(message) || isCorrespondence(message)) return []
  const body = message.content
  return [
    {
      kind: "sender",
      id: message.message_id,
      sender: senderOf(message, lookups),
      preview: previewMarkup(previewText(message.preview) || body) ?? "",
      body: phoneLinks(body, lookups),
      failed: failed(message),
      at
    }
  ]
}

function userItem(message: HistoryMessage): MobileConversationItem {
  const sent = splitAttachedFiles(message.content)
  const quoted = message.reply_to[0]
  return {
    kind: "user",
    id: message.message_id,
    client: message.client,
    text: sent.text,
    photos: message.role === ROLE.user ? message.images.length : 0,
    files: sent.files.map((file) => file.name),
    reply_to:
      quoted === undefined
        ? { kind: "fresh" }
        : {
            kind: "quote",
            role: quoted.role,
            text: previewLine(withFileNames(quoted.content)) ?? quoted.content
          },
    sent_from: message.role === ROLE.user ? message.sent_from : { kind: SENT_FROM.typed }
  }
}

type SenderRow = Extract<MobileConversationItem, { readonly kind: "sender" }>["sender"]

const senderOf = (sender: InteractionSender, lookups: ConversationLookups): SenderRow => {
  const name =
    (sender.from.name.kind === ACTOR_NAME.named ? sender.from.name.text.trim() : "") ||
    sender.from.id
  if (isCommandArrival(sender)) return { kind: "command", name }
  if (sender.from.source === INTERACTION_SOURCE.workflow) return { kind: "workflow" }
  return { kind: "agent", name, chat: chatLink(lookups.sessionIds.get(sender.from.id)) }
}

const previewText = (preview: InteractionPreview): string =>
  preview.kind === INTERACTION_PREVIEW.previewed ? preview.text.trim() : ""

const chatLink = (sessionId: string | undefined): MobileChatLink =>
  sessionId === undefined
    ? { kind: MOBILE_CHAT_LINK.unlinked }
    : { kind: MOBILE_CHAT_LINK.linked, session_id: sessionId }

const titleOf = (title: string | undefined) =>
  title === undefined ? { kind: "unnamed" as const } : { kind: "named" as const, title }

const failed = (sender: InteractionSender): boolean =>
  sender.kind === INTERACTION_KIND.completion &&
  sender.outcome !== INTERACTION_OUTCOME.completed &&
  sender.outcome !== INTERACTION_OUTCOME.interrupted

function internalWorkMessage(message: HistoryMessage): boolean {
  return isInternalWorkMessage({
    role: message.role,
    forwarded: isForwarded(message),
    carriesWork:
      message.role === ROLE.interaction &&
      (message.communication.kind !== COMMUNICATION_ROW.none ||
        message.update.kind !== UPDATE_ROW.none ||
        message.agent_result.kind !== AGENT_RESULT_ROW.none),
    sender:
      message.role === ROLE.interaction
        ? {
            kind: "attributed",
            sender: message,
            origin:
              message.from_chat.kind === FROM_CHAT.handedOver
                ? { kind: "from_chat", sessionRef: message.from_chat.session_ref }
                : { kind: "direct" }
          }
        : { kind: "unattributed" }
  })
}

const isForwarded = (message: HistoryMessage): boolean =>
  (message.role === ROLE.user || message.role === ROLE.interaction) &&
  message.forwarded_from.kind === FORWARDED_FROM.forwarded

const handoffOf = (
  message: HistoryMessage
): { readonly session_id: string; readonly session_ref: string } | undefined =>
  message.role === ROLE.interaction && message.from_chat.kind === FROM_CHAT.handedOver
    ? message.from_chat
    : undefined

function sendOf(call: HistoryToolCall): { ref: string; title: string } | undefined {
  if (call.name !== VIEWED_TOOL.session_send_message) return undefined
  if (call.status.kind === TOOL_CALL_STATUS.settled && call.status.is_error) return undefined
  if (call.data.kind !== TOOL_DATA.attached) return undefined
  const data = call.data.value
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
  const sessionId = lookups.sessionIds.get(send.ref)
  const title =
    (sessionId === undefined ? undefined : lookups.names.get(sessionId)) ??
    (send.title || "another chat")
  return { kind: "sent", id: call.id, chat: chatLink(sessionId), title }
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

function liveText(progress: RunProgressRecord | undefined): string {
  const tools = progress?.active_tools ?? []
  const titles = tools.flatMap((tool) =>
    tool.title.kind === TOOL_TITLE.titled && tool.title.title.trim() !== ""
      ? [tool.title.title]
      : []
  )
  const titled = titles.at(-1)
  if (titled !== undefined) return titled.trim()
  return tools.length > 0 ? "Working" : "Thinking"
}
