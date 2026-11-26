import { SERVER_EVENT_TYPE } from "@arden-hq/protocol"
import { INTERNAL_LIFECYCLE_EVENT } from "../sessions/internal-events.js"
import type { LifecycleFeedEvent } from "../sessions/events.js"
import { linkedItemId } from "./event-links.js"

export const taskWorkItemId = (event: LifecycleFeedEvent): string | null => {
  switch (event.type) {
    case SERVER_EVENT_TYPE.workChanged:
    case SERVER_EVENT_TYPE.taskVisibilityChanged:
      return event.item_id
    case SERVER_EVENT_TYPE.questionChanged:
      return linkedItemId(event.task)
    case SERVER_EVENT_TYPE.automationProgress:
    case SERVER_EVENT_TYPE.automationFinished:
    case SERVER_EVENT_TYPE.recordTold:
    case SERVER_EVENT_TYPE.taskProposalChanged:
    case SERVER_EVENT_TYPE.focusChoiceChanged:
    case SERVER_EVENT_TYPE.chatInputCommitted:
    case SERVER_EVENT_TYPE.navigationRequested:
    case SERVER_EVENT_TYPE.mcpServerChanged:
    case SERVER_EVENT_TYPE.entityChanged:
    case INTERNAL_LIFECYCLE_EVENT.runSettled:
    case INTERNAL_LIFECYCLE_EVENT.runFenced:
    case INTERNAL_LIFECYCLE_EVENT.limitCrossed:
    case INTERNAL_LIFECYCLE_EVENT.approvalWaiting:
    case INTERNAL_LIFECYCLE_EVENT.decisionRouteChanged:
    case INTERNAL_LIFECYCLE_EVENT.captureArrived:
    case INTERNAL_LIFECYCLE_EVENT.automationQueued:
    case INTERNAL_LIFECYCLE_EVENT.automationChanged:
    case INTERNAL_LIFECYCLE_EVENT.taskHistoryAdded:
      return null
  }
}
