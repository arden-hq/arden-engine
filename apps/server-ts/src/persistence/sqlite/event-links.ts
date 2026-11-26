import {
  ENTITY_TARGET,
  LINK,
  TASK_SPACE,
  type EntityChangeTarget,
  type LinkedAutomation,
  type LinkedChat,
  type LinkedTask,
  type TaskSpace
} from "@arden-hq/protocol"

export const linkedChat = (sessionId: string | null): LinkedChat =>
  sessionId === null ? { kind: LINK.none } : { kind: LINK.chat, session_id: sessionId }

export const linkedAutomation = (automationId: string | null): LinkedAutomation =>
  automationId === null
    ? { kind: LINK.none }
    : { kind: LINK.automation, automation_id: automationId }

export const linkedTask = (itemId: string | null): LinkedTask =>
  itemId === null ? { kind: LINK.none } : { kind: LINK.task, item_id: itemId }

export const taskSpace = (spaceId: string | null): TaskSpace =>
  spaceId === null ? { kind: TASK_SPACE.none } : { kind: TASK_SPACE.space, space_id: spaceId }

export const entityTarget = (id: string | null): EntityChangeTarget =>
  id === null ? { kind: ENTITY_TARGET.many } : { kind: ENTITY_TARGET.one, id }

export const linkedItemId = (task: LinkedTask): string | null =>
  task.kind === LINK.task ? task.item_id : null
