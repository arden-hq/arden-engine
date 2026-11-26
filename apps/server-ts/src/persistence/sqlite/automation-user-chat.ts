import { SESSION_TYPE } from "@arden-hq/protocol/sessions"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { isSpaceWorkJob, type JobPurpose } from "../job-classification.js"
import { storeError } from "./automation-rows.js"

export const requireUserChat = Effect.fn("SqliteAutomationStore.requireUserChat")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  operation: "create" | "update",
  automationId?: string
) {
  const rows = yield* sql<{
    readonly session_type: string
    readonly origin_automation_id: string | null
    readonly origin_purpose: JobPurpose | null
  }>`
    SELECT session.session_type, session.origin_automation_id, origin.purpose AS origin_purpose
    FROM sessions AS session LEFT JOIN scheduled_tasks AS origin
      ON origin.task_id = session.origin_automation_id
    WHERE session.session_id = ${sessionId} AND session.archived_at IS NULL
    LIMIT 1
  `
  const chat = rows[0]
  const yours =
    (chat?.session_type === SESSION_TYPE.chat && chat.origin_automation_id === null) ||
    (chat?.session_type === SESSION_TYPE.channel &&
      chat.origin_purpose !== null &&
      isSpaceWorkJob({ purpose: chat.origin_purpose }))
  if (!yours) {
    return yield* storeError(
      operation,
      "invalid",
      "An Automation's chat must be one of your active chats or a Space room",
      automationId
    )
  }
})
