import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { namedPublicRef } from "../public-ref.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import type { WorkOwner } from "./automation-rows.js"
import { nextId } from "./deps.js"
import { insertSession } from "./session-insert.js"
import { spaceJobId } from "../space-job-id.js"

/**
 * The run chat one attempt gets under its owner's private trunk
 * (`prepareRunSession`): one per attempt, made once, so a reclaim finds it again.
 */
export const attemptRunSessionId = (trunk: string, attemptId: number): string =>
  `${trunk}::i${attemptId}`

/** `attemptRunSessionId` in SQL, for a trunk and an attempt id named in the query. */
export const attemptRunSessionIdSql = (
  sql: SqlClient.SqlClient,
  trunk: Statement.Fragment,
  attemptId: Statement.Fragment
): Statement.Fragment => sql`(${trunk} || '::i' || ${attemptId})`

/**
 * Records a Space review's private chat (`space_review_chats`). Its sync gives it
 * one only when it has none ("keep"). A claim that finds that chat archived gives
 * it a new one ("replace"). Nothing else writes the pointer.
 */
export const recordReviewChat = (
  sql: SqlClient.SqlClient,
  spaceId: string,
  sessionId: string,
  mode: "keep" | "replace"
) =>
  (mode === "keep"
    ? sql`INSERT INTO space_review_chats (space_id, session_id) VALUES (${spaceId}, ${sessionId})
        ON CONFLICT(space_id) DO NOTHING`
    : sql`INSERT INTO space_review_chats (space_id, session_id) VALUES (${spaceId}, ${sessionId})
        ON CONFLICT(space_id) DO UPDATE SET session_id = excluded.session_id`
  ).pipe(Effect.asVoid)

/**
 * A Space rename renames its review's private chats that still carry the name the
 * review had (`<old Space name> worker`). A chat a person renamed keeps its name, as
 * `chatsFollowJobName` (job-labels.ts) does for a job's chats. Called where the old
 * and the new Space name are both known: the rename itself.
 */
export const followSpaceName = (
  sql: SqlClient.SqlClient,
  spaceId: string,
  before: string,
  after: string
) =>
  sql`UPDATE sessions SET name = ${`${after} worker`}
    WHERE origin_automation_id = ${spaceJobId(spaceId)} AND session_type = 'channel'
      AND name = ${`${before} worker`}`.pipe(Effect.asVoid)

export const makeOwnerChats = (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"]
) => {
  /**
   * A new private chat for one owner. An Automation records it as its set chat
   * and a review as its private chat. A Task's is the oldest live one for its key.
   */
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
