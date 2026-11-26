export const THREAD_LOCATION = { waiting: "waiting", source: "source", target: "target" } as const

export type ThreadLocation = {
  readonly kind: (typeof THREAD_LOCATION)[keyof typeof THREAD_LOCATION]
}

export const THREAD_TRANSITION = {
  moved: "moved",
  kept: "kept",
  typedHere: "typed_here",
  broughtBack: "brought_back"
} as const

export const THREAD_STEP = {
  applied: "applied",
  unchanged: "unchanged",
  refused: "refused"
} as const

type ThreadTransition = (typeof THREAD_TRANSITION)[keyof typeof THREAD_TRANSITION]

export const THREAD_EVENT = {
  chooseTarget: "choose_target",
  chooseHere: "choose_here",
  typedHere: "typed_here",
  bringBack: "bring_back"
} as const

export type ThreadEvent = { readonly kind: (typeof THREAD_EVENT)[keyof typeof THREAD_EVENT] }

export interface ThreadEffects {
  readonly forwardToTarget: boolean
  readonly answerSource: boolean
}

export type ThreadStep =
  | {
      readonly kind: typeof THREAD_STEP.applied
      readonly location: Exclude<ThreadLocation["kind"], "waiting">
      readonly transition: ThreadTransition
      readonly effects: ThreadEffects
    }
  | { readonly kind: typeof THREAD_STEP.unchanged }
  | { readonly kind: typeof THREAD_STEP.refused; readonly reason: string }

const none: ThreadEffects = { forwardToTarget: false, answerSource: false }

export const threadStep = (location: ThreadLocation, event: ThreadEvent): ThreadStep => {
  switch (location.kind) {
    case THREAD_LOCATION.waiting:
      switch (event.kind) {
        case THREAD_EVENT.chooseTarget:
          return {
            kind: "applied",
            location: "target",
            transition: "moved",
            effects: { forwardToTarget: true, answerSource: false }
          }
        case THREAD_EVENT.chooseHere:
          return {
            kind: "applied",
            location: "source",
            transition: "kept",
            effects: { forwardToTarget: false, answerSource: true }
          }
        case THREAD_EVENT.typedHere:
          return { kind: "applied", location: "source", transition: "typed_here", effects: none }
        case THREAD_EVENT.bringBack:
          return { kind: "refused", reason: "This thread has not moved; it is still here" }
      }
      break
    case THREAD_LOCATION.target:
      switch (event.kind) {
        case THREAD_EVENT.chooseTarget:
        case THREAD_EVENT.typedHere:
          return { kind: "unchanged" }
        case THREAD_EVENT.chooseHere:
          return { kind: "refused", reason: "This thread already moved to the other chat" }
        case THREAD_EVENT.bringBack:
          return { kind: "applied", location: "source", transition: "brought_back", effects: none }
      }
      break
    case THREAD_LOCATION.source:
      switch (event.kind) {
        case THREAD_EVENT.chooseHere:
        case THREAD_EVENT.typedHere:
        case THREAD_EVENT.bringBack:
          return { kind: "unchanged" }
        case THREAD_EVENT.chooseTarget:
          return { kind: "refused", reason: "This thread already continues here" }
      }
  }
}
