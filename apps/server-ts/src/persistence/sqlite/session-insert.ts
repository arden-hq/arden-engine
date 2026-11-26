import { SESSION_TYPE } from "@arden-hq/protocol/sessions"
import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import type { SessionLifecycleEventError, SessionLifecycleEvents } from "../sessions/events.js"
import type { UnitOfWork } from "../unit-of-work.js"
import type { SpaceId } from "../space-job-id.js"

interface SessionInsertBase {
  readonly sessionId: string
  readonly publicRef: string
  readonly startedAt: string
  readonly name: string | null
  readonly metadata: string
  readonly spaceId: string | null
  readonly chatModel: string | null
  readonly originAutomationId: string | null
}

interface OwnerChatInsert extends SessionInsertBase {
  readonly type: "chat"
  readonly spaceId: SpaceId
  readonly originAutomationId: null
  readonly parent: null
}

interface ChildChatInsert extends SessionInsertBase {
  readonly type: "chat"
  readonly parent: { readonly sessionId: string; readonly messageId: string | null }
}

interface ChannelSessionInsert extends SessionInsertBase {
  readonly type: "channel"
}

interface AgentSessionInsert extends SessionInsertBase {
  readonly type: "agent"
  readonly parent: {
    readonly sessionId: string
    readonly runId: string
    readonly toolCallId: string
  }
}

const LIFECYCLE_ANNOUNCE = { announce: "announce", silent: "silent" } as const

type SessionInsert = OwnerChatInsert | ChildChatInsert | ChannelSessionInsert | AgentSessionInsert

interface AnnouncedSession<A, E, R> {
  readonly kind: typeof LIFECYCLE_ANNOUNCE.announce
  readonly events: SessionLifecycleEvents["Service"]
  readonly complete: Effect.Effect<A, E, R>
}

interface SilentSession {
  readonly kind: typeof LIFECYCLE_ANNOUNCE.silent
  readonly reason: "worker_channel" | "run_session" | "branch"
}

export function insertSession<A, E, R>(options: {
  readonly sql: SqlClient.SqlClient
  readonly session: SessionInsert
  readonly lifecycle: AnnouncedSession<A, E, R>
}): Effect.Effect<A, SqlError.SqlError | E | SessionLifecycleEventError, R | UnitOfWork>
export function insertSession(options: {
  readonly sql: SqlClient.SqlClient
  readonly session: SessionInsert
  readonly lifecycle: SilentSession
}): Effect.Effect<void, SqlError.SqlError>
export function insertSession<A, E, R>({
  sql,
  session,
  lifecycle
}: {
  readonly sql: SqlClient.SqlClient
  readonly session: SessionInsert
  readonly lifecycle: AnnouncedSession<A, E, R> | SilentSession
}): Effect.Effect<A | void, SqlError.SqlError | E | SessionLifecycleEventError, R | UnitOfWork> {
  const parent = parentLinks(session)
  const insert = sql`INSERT INTO sessions (
    session_id, public_ref, started_at, last_activity, metadata,
    name, session_type, origin_automation_id, parent_session_id,
    parent_run_id, parent_tool_call_id, parent_message_id, space_id,
    chat_model, context_generation, active_message_count, visible_message_count,
    context_from_seq
  ) VALUES (
    ${session.sessionId}, ${session.publicRef}, ${session.startedAt}, ${session.startedAt},
    ${session.metadata}, ${session.name}, ${session.type},
    ${session.originAutomationId}, ${parent.sessionId}, ${parent.runId}, ${parent.toolCallId},
    ${parent.messageId}, ${session.spaceId}, ${session.chatModel}, 0, 0, 0, 0
  )`
  if (lifecycle.kind === LIFECYCLE_ANNOUNCE.silent) return Effect.asVoid(insert)
  return insert.pipe(
    Effect.andThen(lifecycle.complete),
    Effect.tap(() => lifecycle.events.appendInTransaction("session_created", session.sessionId))
  )
}

const parentLinks = (session: SessionInsert) => {
  switch (session.type) {
    case SESSION_TYPE.chat:
      return {
        sessionId: session.parent?.sessionId ?? null,
        runId: null,
        toolCallId: null,
        messageId: session.parent?.messageId ?? null
      }
    case SESSION_TYPE.channel:
      return { sessionId: null, runId: null, toolCallId: null, messageId: null }
    case SESSION_TYPE.agent:
      return { ...session.parent, messageId: null }
  }
}
