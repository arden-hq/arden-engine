/** Chat placement is independent of the latest Run's origin or authority. */
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
      readonly owner: SessionOwner | null
    }

export type SessionOwner =
  | { readonly kind: "space"; readonly id: string; readonly name: string }
  | { readonly kind: "task"; readonly id: string; readonly name: string }
  | { readonly kind: "automation"; readonly id: string; readonly name: string }
  | { readonly kind: "session"; readonly id: string; readonly name: string }
