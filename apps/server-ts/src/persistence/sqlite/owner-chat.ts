import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { namedPublicRef } from "../public-ref.js"
import type { SessionLifecycleEvents, SessionLifecycleEventError } from "../sessions/events.js"
import { nextId } from "./deps.js"
import { insertSession } from "./session-insert.js"
import { spaceJobId } from "../space-job-id.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { UnitOfWork } from "../unit-of-work.js"
import { type WorkOwner } from "./automation-rows.js"

export const attemptRunSessionId = (trunk: string, attemptId: number): string =>
  `${trunk}::i${attemptId}`

export const attemptRunSessionIdSql = (
  sql: SqlClient.SqlClient,
  trunk: Statement.Fragment,
  attemptId: Statement.Fragment
): Statement.Fragment => sql`(${trunk} || '::i' || ${attemptId})`

export const recordReviewChat = (
  sql: SqlClient.SqlClient,
  spaceId: string,
  sessionId: string,
  mode: "keep" | "replace"
): Effect.Effect<void, SqlError, never> =>
  (mode === "keep"
    ? sql`INSERT INTO space_review_chats (space_id, session_id) VALUES (${spaceId}, ${sessionId})
        ON CONFLICT(space_id) DO NOTHING`
    : sql`INSERT INTO space_review_chats (space_id, session_id) VALUES (${spaceId}, ${sessionId})
        ON CONFLICT(space_id) DO UPDATE SET session_id = excluded.session_id`
  ).pipe(Effect.asVoid)

export const followSpaceName = (
  sql: SqlClient.SqlClient,
  spaceId: string,
  before: string,
  after: string
): Effect.Effect<void, SqlError, never> =>
  sql`UPDATE sessions SET name = ${`${after} worker`}
    WHERE origin_automation_id = ${spaceJobId(spaceId)} AND session_type = 'channel'
      AND name = ${`${before} worker`}`.pipe(Effect.asVoid)

export interface OwnerChats {
  readonly openChat: (chat: {
    readonly owner: WorkOwner
    readonly name: string
    readonly spaceId: string | null
    readonly model: string | null
    readonly now: string
  }) => Effect.Effect<string, SqlError | SessionLifecycleEventError, UnitOfWork>
  readonly isLiveChat: (sessionId: string) => Effect.Effect<boolean, SqlError>
}

export const makeOwnerChats = (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"]
): OwnerChats => {
  const openChat = Effect.fn("SqliteAutomationStore.openChat")(function* (chat: {
    readonly owner: WorkOwner
    readonly name: string
    readonly spaceId: string | null
    readonly model: string | null
    readonly now: string
  }) {
    const threadId = yield* nextId
    const { owner } = chat
    yield* insertSession({
      sql,
      session: {
        type: "channel",
        sessionId: threadId,
        publicRef: namedPublicRef(chat.name, threadId),
        startedAt: chat.now,
        name: chat.name,
        metadata: "{}",
        spaceId: chat.spaceId,
        chatModel: chat.model,
        originAutomationId: owner.key
      },
      lifecycle: {
        kind: "announce",
        events: sessionEvents,
        complete:
          owner.kind === "space_review"
            ? recordReviewChat(sql, owner.spaceId, threadId, "replace")
            : sql`UPDATE scheduled_tasks SET thread_id = ${threadId}
                WHERE task_id = ${owner.key} AND purpose IN ('user_automation', 'system')`.pipe(
                Effect.asVoid
              )
      }
    })
    return threadId
  })

  const isLiveChat = Effect.fn("SqliteAutomationStore.isLiveChat")(function* (sessionId: string) {
    const live = yield* sql<{ readonly session_id: string }>`
      SELECT session_id FROM sessions
      WHERE session_id = ${sessionId} AND archived_at IS NULL
      LIMIT 1
    `
    return live.length > 0
  })

  return { openChat, isLiveChat }
}
