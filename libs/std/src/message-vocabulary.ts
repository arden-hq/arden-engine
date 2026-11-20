export const ROLE = {
  system: "system",
  developer: "developer",
  user: "user",
  interaction: "interaction",
  assistant: "assistant",
  tool: "tool"
} as const
export type Role = (typeof ROLE)[keyof typeof ROLE]
export const ROLES = Object.values(ROLE)

export const INTERACTION_SOURCE = {
  agent: "agent",
  workflow: "workflow",
  tool: "tool",
  automation: "automation",
  harness: "harness"
} as const
export type InteractionSource = (typeof INTERACTION_SOURCE)[keyof typeof INTERACTION_SOURCE]
export const INTERACTION_SOURCES = Object.values(INTERACTION_SOURCE)

export const INTERACTION_KIND = {
  message: "message",
  assignment: "assignment",
  instruction: "instruction",
  event: "event",
  completion: "completion"
} as const
export type InteractionKind = (typeof INTERACTION_KIND)[keyof typeof INTERACTION_KIND]
export const INTERACTION_KINDS = Object.values(INTERACTION_KIND)

export const INTERACTION_OUTCOME = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  needsAttention: "needs_attention",
  interrupted: "interrupted"
} as const
export type InteractionOutcome = (typeof INTERACTION_OUTCOME)[keyof typeof INTERACTION_OUTCOME]
export const INTERACTION_OUTCOMES = Object.values(INTERACTION_OUTCOME)
