export type ThreadLocation =
  | { readonly kind: "waiting" }
  | { readonly kind: "source" }
  | { readonly kind: "target" }

type ThreadTransition = "moved" | "kept" | "typed_here" | "brought_back"

export type ThreadEvent =
  | { readonly kind: "choose_target" }
  | { readonly kind: "choose_here" }
  | { readonly kind: "typed_here" }
  | { readonly kind: "bring_back" }

interface ThreadEffects {
  readonly forwardToTarget: boolean
  readonly answerSource: boolean
}

export type ThreadStep =
  | {
      readonly kind: "applied"
      readonly location: Exclude<ThreadLocation["kind"], "waiting">
      readonly transition: ThreadTransition
      readonly effects: ThreadEffects
    }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: string }

const none: ThreadEffects = { forwardToTarget: false, answerSource: false }

export const threadStep = (location: ThreadLocation, event: ThreadEvent): ThreadStep => {
  switch (location.kind) {
    case "waiting":
      switch (event.kind) {
        case "choose_target":
          return {
            kind: "applied",
            location: "target",
            transition: "moved",
            effects: { forwardToTarget: true, answerSource: false }
          }
        case "choose_here":
          return {
            kind: "applied",
            location: "source",
            transition: "kept",
            effects: { forwardToTarget: false, answerSource: true }
          }
        case "typed_here":
          return { kind: "applied", location: "source", transition: "typed_here", effects: none }
        case "bring_back":
          return { kind: "refused", reason: "This thread has not moved; it is still here" }
      }
      break
    case "target":
      switch (event.kind) {
        case "choose_target":
        case "typed_here":
          return { kind: "unchanged" }
        case "choose_here":
          return { kind: "refused", reason: "This thread already moved to the other chat" }
        case "bring_back":
          return { kind: "applied", location: "source", transition: "brought_back", effects: none }
      }
      break
    case "source":
      switch (event.kind) {
        case "choose_here":
        case "typed_here":
        case "bring_back":
          return { kind: "unchanged" }
        case "choose_target":
          return { kind: "refused", reason: "This thread already continues here" }
      }
  }
}
