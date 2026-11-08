import { captureMutationVersions } from "./mutation-links.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { DEFAULT_APPROVAL_MODE } from "@arden-hq/protocol/permissions"
import { Clock, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { namedPublicRef } from "../public-ref.js"
import type { AutomationJobLeaseRef } from "../automations/store.js"
import { AutomationStoreError } from "../automations/store.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import { storeError } from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import { nextId } from "./deps.js"
import { insertSession } from "./session-insert.js"
import { userAutomationSql } from "./authority-sql.js"

export const insertOwnChat = <A, E, R>(input: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: AutomationStoreDeps["sessionEvents"]
  readonly automationId: string
  readonly sessionId: string
  readonly name: string
  readonly model: string | null
  readonly approvalMode: string
  readonly startedAt: string
  readonly complete: Effect.Effect<A, E, R>
}) =>
  insertSession({
    sql: input.sql,
    session: {
      type: "channel",
      sessionId: input.sessionId,
      publicRef: namedPublicRef(input.name, input.sessionId),
      startedAt: input.startedAt,
      name: input.name,
      metadata: JSON.stringify({
        approval_mode: input.approvalMode,
        policy_generation: 0
      }),
      spaceId: null,
      chatModel: input.model,
      originAutomationId: input.automationId
    },
    lifecycle: { kind: "announce", events: input.sessionEvents, complete: input.complete }
  })

export const ownChat = Effect.fn("SqliteAutomationStore.ownChat")(function* (input: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: AutomationStoreDeps["sessionEvents"]
  readonly automationId: string
  readonly name: string
  readonly model: string | null
  readonly mutation?: MutationOperationIdentity | undefined
}) {
  const own = yield* input.sql<{ readonly session_id: string }>`
    SELECT session_id FROM sessions
    WHERE origin_automation_id = ${input.automationId}
      AND session_type = 'channel'
      AND archived_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `
  if (own[0] !== undefined) return own[0].session_id
  const sessionId = yield* nextId
  const recordVersions = yield* captureMutationVersions(input.sql, {
    domain: "session",
    id: sessionId,
    identity: input.mutation
  })
  yield* insertOwnChat({
    ...input,
    sessionId,
    approvalMode: DEFAULT_APPROVAL_MODE,
    startedAt: iso(yield* Clock.currentTimeMillis),
    complete: Effect.void
  })
  yield* recordVersions
  return sessionId
})

export const makeOwnChats = ({
  writer,
  sessionEvents
}: Pick<AutomationStoreDeps, "writer" | "sessionEvents">) => {
  const sql = writer.sql
  const prepareOwnChat = Effect.fn("SqliteAutomationStore.prepareOwnChat")(function* (
    lease: AutomationJobLeaseRef
  ) {
    const automationId = lease.payload.automationId
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly name: string; readonly model: string | null }>`
            SELECT name, model FROM scheduled_tasks
            WHERE task_id = ${automationId} AND ${userAutomationSql()}`
          const row = rows[0]
          if (row === undefined) {
            return yield* storeError(
              "prepare_run_session",
              "not_found",
              "Only a user's Automation has its own chat",
              automationId
            )
          }
          return yield* ownChat({ sql, sessionEvents, automationId, ...row })
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "prepare_run_session",
                "storage",
                "Could not prepare the Automation's own chat",
                automationId,
                cause
              )
        )
      )
  })
  return { prepareOwnChat }
}
