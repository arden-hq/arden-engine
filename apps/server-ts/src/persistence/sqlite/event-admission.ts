import { SERVER_EVENT_TYPE } from "@arden-hq/protocol"
import { Schema } from "effect"
import { EVENT_ADMISSION, isEphemeralChatEvent, type EventDraft } from "../events/model.js"
import {
  ACTIVE_PROJECTION,
  terminalEventRunId,
  type ActiveProjectionState
} from "../events/active-projection.js"

export const EventAdmissionRowSchema = Schema.Struct({
  event_type: Schema.Literals([
    SERVER_EVENT_TYPE.runStarted,
    SERVER_EVENT_TYPE.runFinished,
    SERVER_EVENT_TYPE.runError,
    SERVER_EVENT_TYPE.runCancelled
  ] as const),
  run_id: Schema.NonEmptyString
})

export const ADMISSION_STATE = { active: "active", terminal: "terminal" } as const

export type EventAdmissionState =
  | { readonly kind: typeof ADMISSION_STATE.active; readonly runId: string | undefined }
  | { readonly kind: typeof ADMISSION_STATE.terminal; readonly runId: string }

export const eventAdmissionState = (
  current: ActiveProjectionState | undefined
): EventAdmissionState | undefined => {
  if (current === undefined) return undefined
  if (current.kind === ACTIVE_PROJECTION.terminal)
    return { kind: ADMISSION_STATE.terminal, runId: current.runId }
  return { kind: ADMISSION_STATE.active, runId: current.runId }
}

export const heldThrough = (projection: ActiveProjectionState | undefined): number => {
  if (projection === undefined) return 0
  switch (projection.kind) {
    case ACTIVE_PROJECTION.ready:
      return projection.records.reduce(
        (highest, { record }) => Math.max(highest, record.sequence),
        0
      )
    case ACTIVE_PROJECTION.overflow:
      return projection.throughSequence
    case ACTIVE_PROJECTION.terminal:
      return 0
  }
}

const draftRunId = (draft: EventDraft): string | undefined => {
  if (draft.runId !== undefined && draft.runId !== null) return draft.runId
  return draft.event.type === SERVER_EVENT_TYPE.runStarted ? draft.event.run_id : undefined
}

const rejectsAppendDraft = (
  current: EventAdmissionState | undefined,
  draft: EventDraft
): boolean => {
  if (draft.admission === EVENT_ADMISSION.detached || current === undefined) return false
  const endedRunId = terminalEventRunId(draft.event)
  if (endedRunId !== undefined) {
    return (
      current.kind === ACTIVE_PROJECTION.terminal ||
      (current.runId !== undefined && current.runId !== endedRunId)
    )
  }
  const runId = draftRunId(draft)
  if (current.kind === ACTIVE_PROJECTION.terminal) {
    if (draft.event.type === SERVER_EVENT_TYPE.approvalResolved && runId === current.runId)
      return false
    return isEphemeralChatEvent(draft.event) || runId === current.runId
  }
  return current.runId !== undefined && runId !== undefined && current.runId !== runId
}

const advanceEventAdmission = (
  current: EventAdmissionState | undefined,
  draft: EventDraft
): EventAdmissionState | undefined => {
  if (draft.event.type === SERVER_EVENT_TYPE.runStarted) {
    return { kind: ADMISSION_STATE.active, runId: draft.event.run_id }
  }
  const endedRunId = terminalEventRunId(draft.event)
  return endedRunId === undefined ? current : { kind: ADMISSION_STATE.terminal, runId: endedRunId }
}

export const rejectedDraftIndex = (
  current: EventAdmissionState | undefined,
  drafts: ReadonlyArray<EventDraft>
): number | undefined => {
  let state = current
  for (const [index, draft] of drafts.entries()) {
    if (rejectsAppendDraft(state, draft)) return index
    state = advanceEventAdmission(state, draft)
  }
  return undefined
}
