import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { type SessionStore } from "../sessions/store.js"
import type { PersistenceDeps } from "./deps.js"
import { storeError } from "./session-rows.js"
import { makeBranchCreation } from "./session-branch-create.js"

export const makeSessionBranch = ({
  writer
}: Pick<PersistenceDeps, "writer">): Pick<
  SessionStore["Service"],
  "branch" | "completeBranchPreparation" | "preparingForks"
> => {
  const sql = writer.sql
  const branch = makeBranchCreation(writer)
  const completeBranchPreparation = Effect.fn("SqliteSessionStore.completeBranchPreparation")(
    function* (input: { readonly childSessionId: string }) {
      const updated = yield* writer
        .transact(
          writer.sql`UPDATE session_fork_requests SET state = 'ready'
        WHERE child_session_id = ${input.childSessionId} AND state = 'preparing'
        RETURNING child_session_id`
        )
        .pipe(
          Effect.mapError((cause) =>
            storeError(
              "branch",
              "storage",
              "Could not complete fork preparation",
              input.childSessionId,
              cause
            )
          )
        )
      if (updated.length > 0) return true
      const existing = yield* writer.sql<{ readonly ready: number }>`SELECT state = 'ready' AS ready
        FROM session_fork_requests WHERE child_session_id = ${input.childSessionId}`.pipe(
        Effect.mapError((cause) =>
          storeError(
            "branch",
            "storage",
            "Could not inspect fork preparation",
            input.childSessionId,
            cause
          )
        )
      )
      return existing[0]?.ready === 1
    }
  )

  const preparingForks = Effect.fn("SqliteSessionStore.preparingForks")(function* (input?: {
    readonly childSessionId?: string
  }) {
    const childSessionId = input?.childSessionId ?? null
    const rows = yield* sql<{
      readonly child_session_id: string
      readonly source_session_id: string
      readonly owner_content: number
    }>`SELECT fork.child_session_id, fork.source_session_id, (
        EXISTS (SELECT 1 FROM chat_runs WHERE session_id = fork.child_session_id)
        OR EXISTS (SELECT 1 FROM session_queued_messages WHERE session_id = fork.child_session_id)
        OR EXISTS (
          SELECT 1 FROM session_revisions AS made
          JOIN session_revisions AS later
            ON later.session_id = made.session_id AND later.version > made.version
          WHERE made.session_id = fork.child_session_id AND made.kind = 'created'
            AND later.kind = 'changed'
            AND (json_extract(later.state_json, '$.name') IS NOT json_extract(made.state_json, '$.name')
              OR json_extract(later.state_json, '$.space_id') IS NOT json_extract(made.state_json, '$.space_id')
              OR json_extract(later.state_json, '$.archived_at') IS NOT json_extract(made.state_json, '$.archived_at'))
        )
        OR EXISTS (
          SELECT 1 FROM session_messages AS own
          WHERE own.session_id = fork.child_session_id AND own.role IN (${ROLE.user}, ${ROLE.interaction})
            AND NOT EXISTS (
              SELECT 1 FROM session_messages AS copied
              WHERE copied.session_id = fork.source_session_id AND copied.message_id = own.message_id
            )
        )
      ) AS owner_content
      FROM session_fork_requests AS fork
      WHERE fork.state = 'preparing'
        AND (${childSessionId} IS NULL OR fork.child_session_id = ${childSessionId})
      ORDER BY fork.child_session_id`.pipe(
      Effect.mapError((cause) =>
        storeError(
          "branch",
          "storage",
          "Could not list preparing forks",
          childSessionId ?? undefined,
          cause
        )
      )
    )
    return rows.map((row) => ({
      childSessionId: row.child_session_id,
      sourceSessionId: row.source_session_id,
      hasOwnerContent: row.owner_content === 1
    }))
  })

  return { branch, completeBranchPreparation, preparingForks }
}
