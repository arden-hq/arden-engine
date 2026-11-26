import { LINK, type LinkedAutomation, type RuntimeRunStatus } from "@arden-hq/protocol"
import type { RunActivity } from "@arden-hq/protocol/chat"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
export { modelIdOf, nameText, runIsActive, spaceIdOf } from "@arden-hq/protocol/sessions"
import {
  ACTIVITY_TEXT,
  AGENT_WORKSPACE,
  FIRST_LINE,
  PARENT_MESSAGE,
  SESSION_ACTIVITY,
  SESSION_FORK,
  SESSION_MODEL,
  SESSION_NAME,
  SESSION_ORIGIN,
  SESSION_PARENT,
  SESSION_RUN,
  SESSION_SPACE,
  SESSION_SUMMARY,
  SESSION_TRIAGE_STATE,
  THREAD_SOURCE,
  type ActivityText,
  type AgentWorkspace,
  type FirstLine,
  type SessionActivity,
  type SessionChatModel,
  type SessionFork,
  type SessionName,
  type SessionOrigin,
  type SessionParent,
  type SessionParentStep,
  type SessionRun,
  type SessionSpace,
  type SessionSummary,
  type SessionThreadSource,
  type SessionTriageDecision,
  type SessionTriageState
} from "@arden-hq/protocol/sessions"

type Absent = null | undefined

export const sessionName = (name: string | Absent): SessionName =>
  name === null || name === undefined
    ? { kind: SESSION_NAME.unnamed }
    : { kind: SESSION_NAME.named, name }

export const sessionSpace = (spaceId: string | Absent): SessionSpace =>
  spaceId === null || spaceId === undefined
    ? { kind: SESSION_SPACE.none }
    : { kind: SESSION_SPACE.space, space_id: spaceId }

export const sessionChatModel = (modelId: string | Absent): SessionChatModel =>
  modelId === null || modelId === undefined
    ? { kind: SESSION_MODEL.inherited }
    : { kind: SESSION_MODEL.pinned, model_id: modelId }

export const sessionOrigin = (
  origin: typeof SESSION_ORIGIN.capture | typeof SESSION_ORIGIN.onboarding | Absent
): SessionOrigin => origin ?? SESSION_ORIGIN.ordinary

export const originAutomation = (automationId: string | Absent): LinkedAutomation =>
  automationId === null || automationId === undefined
    ? { kind: LINK.none }
    : { kind: LINK.automation, automation_id: automationId }

export const sessionParent = (parent: {
  readonly sessionId: string | Absent
  readonly runId: string | Absent
  readonly toolCallId: string | Absent
  readonly messageId: string | Absent
  readonly step: SessionParentStep
}): SessionParent => {
  if (parent.sessionId === null || parent.sessionId === undefined)
    return { kind: SESSION_PARENT.none }
  if (
    parent.runId !== null &&
    parent.runId !== undefined &&
    parent.toolCallId !== null &&
    parent.toolCallId !== undefined
  )
    return {
      kind: SESSION_PARENT.agent,
      session_id: parent.sessionId,
      run_id: parent.runId,
      tool_call_id: parent.toolCallId,
      step: parent.step
    }
  return {
    kind: SESSION_PARENT.chat,
    session_id: parent.sessionId,
    message:
      parent.messageId === null || parent.messageId === undefined
        ? { kind: PARENT_MESSAGE.whole }
        : { kind: PARENT_MESSAGE.message, message_id: parent.messageId }
  }
}

export const sessionRun = (run: {
  readonly latest: { readonly runId: string; readonly status: RuntimeRunStatus } | undefined
  readonly turnId: string | Absent
}): SessionRun => {
  if (run.latest === undefined) return { kind: SESSION_RUN.none }
  const { runId, status } = run.latest
  return isActiveRunStatus(status) && run.turnId !== null && run.turnId !== undefined
    ? { kind: SESSION_RUN.active, run_id: runId, turn_id: run.turnId, status }
    : { kind: SESSION_RUN.settled, run_id: runId, status }
}

export const sessionTriage = (decision: SessionTriageDecision | Absent): SessionTriageState =>
  decision === null || decision === undefined
    ? { kind: SESSION_TRIAGE_STATE.none }
    : { kind: SESSION_TRIAGE_STATE.decided, decision }

export const sessionFork = (
  fork: { readonly at: string; readonly turn_id: string } | Absent
): SessionFork =>
  fork === null || fork === undefined
    ? { kind: SESSION_FORK.none }
    : { kind: SESSION_FORK.fork, at: fork.at, turn_id: fork.turn_id }

export const threadSource = (
  sourceId: string | Absent,
  sourceRef: string | Absent
): SessionThreadSource => {
  if (sourceId === null || sourceId === undefined) return { kind: THREAD_SOURCE.none }
  return sourceRef === null || sourceRef === undefined
    ? { kind: THREAD_SOURCE.gone, session_id: sourceId }
    : { kind: THREAD_SOURCE.thread, session_id: sourceId, session_ref: sourceRef }
}

export const sessionSummary = (text: string | Absent): SessionSummary =>
  text === null || text === undefined
    ? { kind: SESSION_SUMMARY.none }
    : { kind: SESSION_SUMMARY.summary, text }

export const agentWorkspace = (path: string | Absent): AgentWorkspace =>
  path === null || path === undefined
    ? { kind: AGENT_WORKSPACE.none }
    : { kind: AGENT_WORKSPACE.workspace, path }

export const firstLine = (text: string | Absent): FirstLine =>
  text === null || text === undefined ? { kind: FIRST_LINE.none } : { kind: FIRST_LINE.line, text }

const activityText = (text: string | Absent): ActivityText =>
  text === null || text === undefined
    ? { kind: ACTIVITY_TEXT.unstated }
    : { kind: ACTIVITY_TEXT.stated, text }

export const sessionActivity = (activity: RunActivity | Absent): SessionActivity =>
  activity === null || activity === undefined
    ? { kind: SESSION_ACTIVITY.idle }
    : {
        kind: SESSION_ACTIVITY.running,
        run_id: activity.run_id,
        sequence: activity.sequence,
        purpose: activityText(activity.purpose),
        run_purpose: activityText(activity.run_purpose),
        operations: (activity.operations ?? []).map((operation) => ({
          id: operation.id,
          text: activityText(operation.text)
        }))
      }
