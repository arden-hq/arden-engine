import { isPublicActivityTool } from "../views/tool-words.js"
import type { ChatProjectionEvent } from "./events/stream.js"
import type { JsonRecord } from "../common/json.js"

export interface RunActivity extends JsonRecord {
  readonly run_id: string
  readonly sequence: number
  readonly description: string | null
  readonly active_tool_call_ids?: ReadonlyArray<string>
  readonly run_purpose?: string | null
  readonly operations?: ReadonlyArray<{ readonly id: string; readonly text: string | null }>
  readonly purpose: string | null
}

export interface RunActivityProjection {
  readonly runId: string
  readonly sequence: number
  readonly purpose: string | null
  readonly operations: ReadonlyArray<{ readonly id: string; readonly text: string | null }>
}

export const reduceRunActivity = (
  current: RunActivityProjection | undefined,
  record: {
    readonly event: ChatProjectionEvent
    readonly sequence: number
    readonly runId?: string | null
  }
): RunActivityProjection | undefined => {
  const event = record.event
  if (current !== undefined && record.sequence <= current.sequence) return current
  if (event.type === "RUN_STARTED") {
    return { runId: event.run_id, sequence: record.sequence, purpose: null, operations: [] }
  }
  if (
    current === undefined ||
    record.sequence <= current.sequence ||
    (record.runId != null && record.runId !== current.runId)
  )
    return current
  if (event.type === "run_activity") {
    return event.run_id === current.runId
      ? {
          ...current,
          sequence: record.sequence,
          ...(event.tool_call_ids === undefined
            ? { purpose: event.description }
            : {
                operations: current.operations.map((operation) =>
                  event.tool_call_ids?.includes(operation.id)
                    ? { ...operation, text: event.description }
                    : operation
                )
              })
        }
      : current
  }
  if (
    event.type === "TOOL_CALL_START" &&
    !event.parent_id &&
    event.presentation !== "conversation" &&
    isPublicActivityTool({ name: event.tool_call_name, presentation: event.presentation })
  ) {
    return {
      ...current,
      sequence: record.sequence,
      operations: [
        ...current.operations.filter((operation) => operation.id !== event.tool_call_id),
        { id: event.tool_call_id, text: null }
      ]
    }
  }
  if (event.type === "TOOL_CALL_RESULT") {
    return {
      ...current,
      sequence: record.sequence,
      operations: current.operations.filter((operation) => operation.id !== event.tool_call_id)
    }
  }
  if (event.type === "model_response_reset") {
    return {
      ...current,
      sequence: record.sequence,
      operations: current.operations.filter(
        (operation) => !event.tool_call_ids.includes(operation.id)
      )
    }
  }
  return current
}

export const runActivityView = (
  state: RunActivityProjection | undefined
): RunActivity | undefined => {
  if (state === undefined) return undefined
  const purpose =
    [...state.operations].reverse().find((operation) => operation.text !== null)?.text ??
    state.purpose
  return {
    run_id: state.runId,
    sequence: state.sequence,
    description: purpose,
    purpose,
    run_purpose: state.purpose,
    operations: state.operations,
    active_tool_call_ids: state.operations.map((operation) => operation.id)
  }
}

export const runActivityProjection = (activity: RunActivity): RunActivityProjection => ({
  runId: activity.run_id,
  sequence: activity.sequence,
  purpose: activity.run_purpose !== undefined ? activity.run_purpose : activity.purpose,
  operations:
    activity.operations ?? (activity.active_tool_call_ids ?? []).map((id) => ({ id, text: null }))
})
