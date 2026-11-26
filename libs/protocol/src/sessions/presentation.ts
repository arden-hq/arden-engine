export type SessionPresentation =
  | { readonly kind: "conversation"; readonly role: "space" | "topic" }
  | {
      readonly kind: "execution"
      readonly label:
        | "Space review"
        | "Task worker"
        | "Agent"
        | "Side chat"
        | "Automation"
        | "System"
      readonly title: string
      readonly owner: SessionOwner
    }

export type SessionOwner =
  | { readonly kind: "none" }
  | { readonly kind: "space"; readonly id: string; readonly name: string }
  | { readonly kind: "task"; readonly id: string; readonly name: string }
  | { readonly kind: "automation"; readonly id: string; readonly name: string }
  | { readonly kind: "session"; readonly id: string; readonly name: string }
