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

const storedSessionToWire = (session: StoredSession) => ({
  session_id: session.sessionId,
  public_ref: session.publicRef,
  started_at: session.startedAt,
  last_activity: session.lastActivity,
  last_accessed_at: session.lastAccessedAt ?? null,
  name: session.name ?? null,
  message_count: session.messageCount,
  space_id: session.spaceId ?? null,
  chat_model: session.chatModel ?? null,
  session_type: session.sessionType,
  origin_automation_id: session.originAutomationId ?? null,
  parent_session_id: session.parentSessionId ?? null,
  parent_tool_call_id: session.parentToolCallId ?? null,
  parent_message_id: session.parentMessageId ?? null,
  parent_run_id: session.parentRunId ?? null
})

export const listedSessionToWire = (session: SessionListEntry): ListedSession => ({
  current_activity: session.currentActivity ?? null,
  presentation: session.presentation,
  ...storedSessionToWire(session),
  has_unread: session.hasUnread,
  active_run_id: session.activeRun?.runId ?? null,
  active_turn_id: session.activeRun?.turnId ?? null,
  run_status: session.latestRun?.status ?? null,
  checkpoint_seq: session.checkpointSeq,
  latest_event_seq: session.latestEventSeq,
  is_active: session.activeRun !== undefined,
  pending_approvals_count: session.pendingApprovalsCount,
  pending_connections_count: session.pendingConnectionsCount,
  run_error_code: session.latestRun?.errorCode ?? null,
  run_stop_reason: session.latestRun?.stopReason ?? null,
  triage: freshTriage(session.triage, session) ?? null,
  fork: session.fork === undefined ? null : { at: session.fork.at, turn_id: session.fork.turn_id },
  fork_origin: session.forkOrigin ?? null,
  thread_source:
    session.threadSource === undefined
      ? null
      : {
          session_id: session.threadSource.sessionId,
          session_ref: session.threadSource.sessionRef
        },
  summary: session.summary ?? null,
  agent_workspace: session.agentWorkspace ?? null,
  latest_run_id: session.latestRunId ?? null,
  origin: session.origin ?? null
})

export const sessionListCursorToWire = (cursor: {
  readonly at: string
  readonly sessionId: string
}): SessionListCursor => ({ at: cursor.at, session_id: cursor.sessionId })

export const archivedSessionToWire = (session: ArchivedSessionEntry): ArchivedSession => ({
  ...storedSessionToWire(session),
  archived_at: session.archivedAt,
  first_line: session.firstLine
})

export const createdSessionToWire = (session: CreatedSession): CreateSessionResponse => ({
  session_id: session.sessionId,
  name: session.name ?? null,
  started_at: session.startedAt,
  last_activity: session.lastActivity,
  message_count: session.messageCount,
  space_id: session.spaceId ?? null,
  chat_model: session.chatModel ?? null,
  origin: session.origin ?? null
})

export const branchedSessionToWire = (session: BranchedSession): BranchSessionResponse => ({
  fork_origin: session.forkOrigin ?? null,
  session_id: session.sessionId,
  name: session.name ?? null,
  started_at: session.startedAt,
  last_activity: session.lastActivity,
  space_id: session.spaceId ?? null
})
