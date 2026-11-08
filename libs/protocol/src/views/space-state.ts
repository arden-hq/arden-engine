import type { SessionPresentation } from "../sessions/presentation.js"

/** The one name for a chat wherever it is listed or titled. A chat with no
 *  name yet is "untitled" everywhere, so a header and the row it belongs to
 *  never read as two different things. */
export function chatName(chat: { readonly name?: string | null | undefined }): string {
  return chat.name?.trim() || "untitled"
}

/** A run of Arden's own housekeeping (Chat summaries, Memory capture, the
 *  daily summary, wiki and storage maintenance: every `system` job), even in a
 *  copy of a Space's chat. It follows every reply, so it never makes a Space
 *  working and is never named as work running there. */
export function isSystemRun(session: {
  readonly presentation?: SessionPresentation | null | undefined
}): boolean {
  return session.presentation?.kind === "execution" && session.presentation.label === "System"
}

/** What a Space's state reads from. */
export interface SpaceStateInput {
  /** The Space worker is looking the Space over right now. */
  readonly reviewing: boolean
  /** Any Session filed on the Space has a run going, executions included. */
  readonly working: boolean
  /** What the Space asks of you, as plain one-line labels, in ask order. */
  readonly asks: ReadonlyArray<string>
}

/** Arden is at it (`working`), it waits on you (`asks`), or neither (`quiet`).
 *  Work wins over a question, so the mark never shows both; work that is
 *  itself held up on you wins over plain work, as the mark's `blocked`
 *  (useSpaces adds it from approvals and questions on the working chat).
 *  `ask` is the first question waiting, whatever the tone: the one thing a
 *  Space says in words. */
export interface SpaceState {
  readonly tone: "working" | "asks" | "quiet"
  readonly ask: { readonly text: string; readonly more: number } | undefined
}

export function spaceState(space: SpaceStateInput): SpaceState {
  const [first, ...rest] = space.asks
  const ask = first === undefined ? undefined : { text: first, more: rest.length }
  if (space.reviewing || space.working) return { tone: "working", ask }
  return { tone: ask === undefined ? "quiet" : "asks", ask }
}
