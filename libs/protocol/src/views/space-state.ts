import type { SessionPresentation } from "../sessions/presentation.js"

/** The one name for a chat wherever it is listed or titled. A chat with no
 *  name yet is "untitled" everywhere, so a header and the row it belongs to
 *  never read as two different things. */
export function chatName(name: string | null | undefined): string {
  return name?.trim() || "untitled"
}

/** A run of Arden's own housekeeping (Chat summaries, Memory capture, the
 *  daily summary, wiki and storage maintenance: every `system` job), even in a
 *  copy of a Space's chat. It follows every reply, so it never makes a Space
 *  working and is never named as work running there. */
export function isSystemRun(presentation: SessionPresentation | null | undefined): boolean {
  return presentation?.kind === "execution" && presentation.label === "System"
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

export const SPACE_ASK = { clear: "clear", waiting: "waiting" } as const

export type SpaceAsk =
  | { readonly kind: "clear" }
  | { readonly kind: "waiting"; readonly text: string; readonly more: number }

export interface SpaceState {
  readonly tone: "working" | "asks" | "quiet"
  readonly ask: SpaceAsk
}

export function spaceState(space: SpaceStateInput): SpaceState {
  const [first, ...rest] = space.asks
  const ask: SpaceAsk =
    first === undefined ? { kind: "clear" } : { kind: "waiting", text: first, more: rest.length }
  if (space.reviewing || space.working) return { tone: "working", ask }
  return { tone: ask.kind === SPACE_ASK.clear ? "quiet" : "asks", ask }
}
