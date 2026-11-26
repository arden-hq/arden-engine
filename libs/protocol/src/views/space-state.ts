import {
  SESSION_EXECUTION_LABEL,
  SESSION_PRESENTATION,
  type SessionPresentation
} from "../sessions/presentation.js"

export function chatName(name: string | null | undefined): string {
  return name?.trim() || "untitled"
}

export function isSystemRun(presentation: SessionPresentation | null | undefined): boolean {
  return (
    presentation?.kind === SESSION_PRESENTATION.execution &&
    presentation.label === SESSION_EXECUTION_LABEL.system
  )
}

export interface SpaceStateInput {
  readonly reviewing: boolean
  readonly working: boolean
  readonly asks: ReadonlyArray<string>
}

export const SPACE_ASK = { clear: "clear", waiting: "waiting" } as const

export type SpaceAsk =
  | { readonly kind: typeof SPACE_ASK.clear }
  | { readonly kind: typeof SPACE_ASK.waiting; readonly text: string; readonly more: number }

export const SPACE_TONE = { working: "working", asks: "asks", quiet: "quiet" } as const
export type SpaceTone = (typeof SPACE_TONE)[keyof typeof SPACE_TONE]

export interface SpaceState {
  readonly tone: SpaceTone
  readonly ask: SpaceAsk
}

export function spaceState(space: SpaceStateInput): SpaceState {
  const [first, ...rest] = space.asks
  const ask: SpaceAsk =
    first === undefined
      ? { kind: SPACE_ASK.clear }
      : { kind: SPACE_ASK.waiting, text: first, more: rest.length }
  if (space.reviewing || space.working) return { tone: SPACE_TONE.working, ask }
  return { tone: ask.kind === SPACE_ASK.clear ? SPACE_TONE.quiet : SPACE_TONE.asks, ask }
}
