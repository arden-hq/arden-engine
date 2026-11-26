import { previewLine } from "@arden-hq/protocol/chat"
import type { SpaceSummary } from "@arden-hq/protocol/spaces"
import { MOBILE_ASK, type MobileAsk, type MobileSpaces } from "@arden-hq/protocol/mobile"
import {
  SESSION_PRESENTATION,
  SESSION_PRESENTATION_ROLE,
  SESSION_RUN,
  SESSION_TYPE,
  type SessionListItem
} from "@arden-hq/protocol/sessions"
import { nameText, runIsActive } from "../sessions/session-states.js"
import { chatName, SPACE_ASK, SPACE_TONE, spaceState, isSystemRun } from "@arden-hq/protocol/views"

type MobileSpace = MobileSpaces["spaces"][number]
type MobileLooseChat = MobileSpaces["loose"][number]

const isConversation = (session: SessionListItem): boolean =>
  session.presentation.kind === SESSION_PRESENTATION.conversation

export const isSpaceHome = (session: SessionListItem): boolean =>
  session.presentation.kind === SESSION_PRESENTATION.conversation &&
  session.presentation.role === SESSION_PRESENTATION_ROLE.space

const isWorking = (session: SessionListItem): boolean =>
  !isSystemRun(session.presentation) && runIsActive(session.run)

const askLabel = (ask: MobileAsk): string => {
  const text = ask.kind === MOBILE_ASK.question ? ask.prompt : ask.title
  return previewLine(text) ?? text
}

const conversationOf = (sessionId: string | undefined): MobileSpace["conversation"] =>
  sessionId === undefined ? { kind: "unopened" } : { kind: "opened", session_id: sessionId }

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
    conversation: conversationOf(chats.find((chat) => isSpaceHome(chat))?.session_id),
    state_line:
      tone === SPACE_TONE.asks && ask.kind === SPACE_ASK.waiting
        ? { tone, text: ask.text, more: ask.more }
        : { tone, text: "", more: 0 }
  }
}

export function looseChats(sessions: ReadonlyArray<SessionListItem>): MobileLooseChat[] {
  return sessions
    .filter(
      (session) =>
        isConversation(session) &&
        session.session_type !== SESSION_TYPE.channel &&
        !isSpaceHome(session)
    )
    .map((session) => ({
      session_id: session.session_id,
      title: chatName(nameText(session.name)),
      has_unread: session.has_unread,
      run:
        session.run.kind === SESSION_RUN.none
          ? { kind: "unrun" }
          : { kind: "run", status: session.run.status },
      working: isWorking(session),
      updated_at: session.last_activity
    }))
}
