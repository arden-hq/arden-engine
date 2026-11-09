import { previewLine } from "@arden-hq/protocol/chat"
import type { SpaceSummary } from "@arden-hq/protocol/spaces"
import type { MobileAsk, MobileSpaces } from "@arden-hq/protocol/mobile"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import type { SessionListItem } from "@arden-hq/protocol/sessions"
import { chatName, spaceState, isSystemRun } from "@arden-hq/protocol/views"

type MobileSpace = MobileSpaces["spaces"][number]
type MobileLooseChat = MobileSpaces["loose"][number]

const isConversation = (session: SessionListItem): boolean =>
  session.presentation?.kind === "conversation"

export const isSpaceHome = (session: SessionListItem): boolean =>
  session.presentation?.kind === "conversation" && session.presentation.role === "space"

const isWorking = (session: SessionListItem): boolean =>
  !isSystemRun(session) && isActiveRunStatus(session.run_status)

const askLabel = (ask: MobileAsk): string => {
  const text = ask.kind === "question" ? ask.prompt : ask.title
  return previewLine(text) ?? text
}

export function mobileSpace({
  space,
  chats,
  live,
  asks
}: {
  readonly space: SpaceSummary
  readonly chats: ReadonlyArray<SessionListItem>
  readonly live: ReadonlyArray<SessionListItem>
  readonly asks: ReadonlyArray<MobileAsk>
}): MobileSpace {
  const { tone, ask } = spaceState({
    reviewing: space.live,
    working: live.some(isWorking),
    asks: asks.map(askLabel)
  })
  return {
    id: space.key,
    name: space.title,
    conversation_session_id: chats.find((chat) => isSpaceHome(chat))?.session_id ?? null,
    state_line:
      tone === "asks" && ask !== undefined
        ? { tone, text: ask.text, more: ask.more }
        : { tone, text: "", more: 0 },
    mark: space.mark
  }
}

export function looseChats(sessions: ReadonlyArray<SessionListItem>): MobileLooseChat[] {
  return sessions
    .filter(
      (session) =>
        isConversation(session) && session.session_type !== "channel" && !session.space_id
    )
    .map((session) => ({
      session_id: session.session_id,
      title: chatName(session),
      has_unread: session.has_unread === true,
      run_status: session.run_status ?? null,
      working: isWorking(session),
      updated_at: session.last_activity
    }))
}
