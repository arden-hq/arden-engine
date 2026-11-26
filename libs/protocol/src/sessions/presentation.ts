export const SESSION_PRESENTATION = {
  conversation: "conversation",
  execution: "execution"
} as const

export const SESSION_PRESENTATION_ROLE = { space: "space", topic: "topic" } as const
export type SessionPresentationRole =
  (typeof SESSION_PRESENTATION_ROLE)[keyof typeof SESSION_PRESENTATION_ROLE]

export const SESSION_EXECUTION_LABEL = {
  spaceReview: "Space review",
  taskWorker: "Task worker",
  agent: "Agent",
  sideChat: "Side chat",
  automation: "Automation",
  system: "System"
} as const
export type SessionExecutionLabel =
  (typeof SESSION_EXECUTION_LABEL)[keyof typeof SESSION_EXECUTION_LABEL]

export type SessionPresentation =
  | {
      readonly kind: typeof SESSION_PRESENTATION.conversation
      readonly role: SessionPresentationRole
    }
  | {
      readonly kind: typeof SESSION_PRESENTATION.execution
      readonly label: SessionExecutionLabel
      readonly title: string
      readonly owner: SessionOwner
    }

export const SESSION_OWNER = {
  none: "none",
  space: "space",
  task: "task",
  automation: "automation",
  session: "session"
} as const
export type SessionOwnerKind = Exclude<
  (typeof SESSION_OWNER)[keyof typeof SESSION_OWNER],
  typeof SESSION_OWNER.none
>

export type SessionOwner =
  | { readonly kind: typeof SESSION_OWNER.none }
  | { readonly kind: SessionOwnerKind; readonly id: string; readonly name: string }
