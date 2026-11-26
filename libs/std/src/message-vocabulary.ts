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

export const TOOL_EXECUTION = { runtime: "runtime", provider: "provider" } as const
export type ToolExecution = (typeof TOOL_EXECUTION)[keyof typeof TOOL_EXECUTION]
export const isToolExecution = (value: unknown): value is ToolExecution =>
  value === TOOL_EXECUTION.runtime || value === TOOL_EXECUTION.provider

export const IMAGE_MEDIA_TYPE = { png: "image/png", jpeg: "image/jpeg" } as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPE)[keyof typeof IMAGE_MEDIA_TYPE]
export const isImageMediaType = (value: unknown): value is ImageMediaType =>
  value === IMAGE_MEDIA_TYPE.png || value === IMAGE_MEDIA_TYPE.jpeg
