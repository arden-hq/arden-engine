export const LINK = { none: "none", chat: "chat", automation: "automation", task: "task" } as const

export type LinkedChat =
  | { readonly kind: typeof LINK.none }
  | { readonly kind: typeof LINK.chat; readonly session_id: string }

export type LinkedAutomation =
  | { readonly kind: typeof LINK.none }
  | { readonly kind: typeof LINK.automation; readonly automation_id: string }

export type LinkedTask =
  | { readonly kind: typeof LINK.none }
  | { readonly kind: typeof LINK.task; readonly item_id: string }

export const TASK_SPACE = { none: "none", space: "space" } as const

export type TaskSpace =
  | { readonly kind: typeof TASK_SPACE.none }
  | { readonly kind: typeof TASK_SPACE.space; readonly space_id: string }

export const ENTITY_TARGET = { many: "many", one: "one" } as const

export type EntityChangeTarget =
  | { readonly kind: typeof ENTITY_TARGET.many }
  | { readonly kind: typeof ENTITY_TARGET.one; readonly id: string }
