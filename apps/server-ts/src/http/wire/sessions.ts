import type {
  ArchivedSession,
  BranchSessionResponse,
  CreateSessionResponse,
  ListedSession,
  SessionListCursor
} from "@arden-hq/protocol/sessions"
import type {
  ArchivedSessionEntry,
  BranchedSession,
  CreatedSession,
  SessionListEntry,
  StoredSession
} from "../../persistence/sessions/store.js"
import { freshTriage } from "../../persistence/sessions/triage.js"
import {
  agentWorkspace,
  firstLine,
  originAutomation,
  sessionActivity,
  sessionChatModel,
  sessionFork,
  sessionName,
  sessionOrigin,
  sessionParent,
  sessionRun,
  sessionSpace,
  sessionSummary,
  sessionTriage,
  threadSource
} from "../../sessions/session-states.js"
import { SESSION_PARENT_STEP, type SessionParentStep } from "@arden-hq/protocol/sessions"

const storedSessionToWire = (session: StoredSession, step: SessionParentStep) => ({
  session_id: session.sessionId,
  public_ref: session.publicRef,
  started_at: session.startedAt,
  last_activity: session.lastActivity,
  name: sessionName(session.name),
  message_count: session.messageCount,
  space: sessionSpace(session.spaceId),
  chat_model: sessionChatModel(session.chatModel),
  session_type: session.sessionType,
  origin_automation: originAutomation(session.originAutomationId),
  parent: sessionParent({
    sessionId: session.parentSessionId,
    runId: session.parentRunId,
    toolCallId: session.parentToolCallId,
    messageId: session.parentMessageId,
    step
  })
})

export const listedSessionToWire = (session: SessionListEntry): ListedSession => ({
  ...storedSessionToWire(session, session.parentStep),
  presentation: session.presentation,
  current_activity: sessionActivity(session.currentActivity),
  has_unread: session.hasUnread,
  run: sessionRun({
    latest:
      session.latestRun === undefined || session.latestRunId === undefined
        ? undefined
        : { runId: session.latestRunId, status: session.latestRun.status },
    turnId: session.activeRun?.turnId
  }),
  checkpoint_seq: session.checkpointSeq,
  latest_event_seq: session.latestEventSeq,
  pending_approvals_count: session.pendingApprovalsCount,
  pending_connections_count: session.pendingConnectionsCount,
  triage: sessionTriage(freshTriage(session.triage, session)),
  fork: sessionFork(session.fork),
  thread_source: threadSource(session.threadSource?.sessionId, session.threadSource?.sessionRef),
  summary: sessionSummary(session.summary),
  agent_workspace: agentWorkspace(session.agentWorkspace),
  origin: sessionOrigin(session.origin)
})

export const sessionListCursorToWire = (cursor: {
  readonly at: string
  readonly sessionId: string
}): SessionListCursor => ({ at: cursor.at, session_id: cursor.sessionId })

export const archivedSessionToWire = (session: ArchivedSessionEntry): ArchivedSession => ({
  ...storedSessionToWire(session, { kind: SESSION_PARENT_STEP.none }),
  archived_at: session.archivedAt,
  first_line: firstLine(session.firstLine)
})

export const createdSessionToWire = (session: CreatedSession): CreateSessionResponse => ({
  session_id: session.sessionId,
  name: sessionName(session.name),
  started_at: session.startedAt,
  last_activity: session.lastActivity,
  message_count: session.messageCount,
  space: sessionSpace(session.spaceId),
  chat_model: sessionChatModel(session.chatModel),
  origin: sessionOrigin(session.origin)
})

export const branchedSessionToWire = (session: BranchedSession): BranchSessionResponse => ({
  session_id: session.sessionId,
  name: sessionName(session.name),
  started_at: session.startedAt,
  last_activity: session.lastActivity,
  space: sessionSpace(session.spaceId)
})
