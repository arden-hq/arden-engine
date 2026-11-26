import type { SessionPresentation } from "@arden-hq/protocol"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { JobPurpose } from "../job-classification.js"
import { ownerJoin } from "./automation-rows.js"
import type { Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"

const NO_OWNER = { kind: "none" } as const

export const readableConversationSql = (sql: SqlClient.SqlClient): Statement<Row> =>
  sql`(session_type = 'chat' AND parent_session_id IS NULL AND parent_message_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM space_job_keys AS job_key
      WHERE job_key.automation_id = origin_automation_id AND job_key.purpose = 'space_review'))`

interface PresentationRow {
  readonly conversation_space_id: string | null
  readonly session_id: string
  readonly session_type: string
  readonly name: string | null
  readonly parent_session_id: string | null
  readonly parent_message_id: string | null
  readonly parent_name: string | null
  readonly purpose: JobPurpose | null
  readonly task_id: string | null
  readonly job_name: string | null
  readonly owner_space_id: string | null
  readonly owner_task_id: string | null
  readonly space_name: string | null
  readonly task_name: string | null
}

export const sessionPresentations = Effect.fn("Sessions.presentation")(function* (
  sql: SqlClient.SqlClient,
  ids: ReadonlyArray<string>
) {
  if (ids.length === 0) return new Map<string, SessionPresentation>()
  const ownerSpace = sql`COALESCE(task.owner_space_id, item.space_id, job_key.space_id)`
  const rows = yield* sql<PresentationRow>`
    SELECT conversation.space_id AS conversation_space_id, s.session_id, s.session_type, s.name, s.parent_session_id, s.parent_message_id,
      parent.name AS parent_name,
      COALESCE(task.purpose, job_key.purpose) AS purpose,
      task.task_id, task.name AS job_name, ${ownerSpace} AS owner_space_id,
      item.item_id AS owner_task_id, space.name AS space_name, item.text AS task_name
    FROM sessions AS s
    LEFT JOIN space_conversations AS conversation ON conversation.session_id = s.session_id
    LEFT JOIN sessions AS parent ON parent.session_id = s.parent_session_id
    ${ownerJoin(sql, sql`s.origin_automation_id`)}
    LEFT JOIN spaces AS space ON space.space_id = ${ownerSpace}
    WHERE s.session_id IN ${sql.in(ids)}
  `
  return new Map(rows.map((row) => [row.session_id, presentation(row)]))
})

const presentation = (row: PresentationRow): SessionPresentation => {
  const topLevelChat =
    row.session_type === "chat" && row.parent_session_id === null && row.parent_message_id === null
  if (topLevelChat && row.purpose === "space_review") {
    return {
      kind: "execution",
      label: "Space review",
      title: row.name?.trim() || `${row.space_name || "Space"} worker`,
      owner:
        row.owner_space_id === null
          ? NO_OWNER
          : { kind: "space", id: row.owner_space_id, name: row.space_name || "Space" }
    }
  }
  if (topLevelChat) {
    return { kind: "conversation", role: row.conversation_space_id === null ? "topic" : "space" }
  }
  if (
    row.session_type === "chat" &&
    row.parent_session_id !== null &&
    row.parent_message_id === null
  ) {
    return {
      kind: "execution",
      label: "Side chat",
      title: row.name?.trim() || "Side chat",
      owner: {
        kind: "session",
        id: row.parent_session_id,
        name: row.parent_name?.trim() || "Parent chat"
      }
    }
  }
  if (row.session_type === "agent") {
    return {
      kind: "execution",
      label: "Agent",
      title: row.name?.trim() || "Agent",
      owner:
        row.parent_session_id === null
          ? NO_OWNER
          : {
              kind: "session",
              id: row.parent_session_id,
              name: row.parent_name?.trim() || "Parent chat"
            }
    }
  }
  switch (row.purpose) {
    case "space_review":
      return {
        kind: "execution",
        label: "Space review",
        title: `${row.space_name || row.job_name || "Space"} · Worker run`,
        owner:
          row.owner_space_id === null
            ? NO_OWNER
            : { kind: "space", id: row.owner_space_id, name: row.space_name || "Space" }
      }
    case "task_execution":
      return {
        kind: "execution",
        label: "Task worker",
        title: `${row.task_name || row.job_name || "Task"} · Worker`,
        owner:
          row.owner_task_id === null
            ? NO_OWNER
            : { kind: "task", id: row.owner_task_id, name: row.task_name || row.job_name || "Task" }
      }
    case "user_automation":
      return {
        kind: "execution",
        label: "Automation",
        title: row.name?.trim() || row.job_name || "Automation",
        owner:
          row.task_id === null
            ? NO_OWNER
            : { kind: "automation", id: row.task_id, name: row.job_name || "Automation" }
      }
    case "system":
      return {
        kind: "execution",
        label: "System",
        title: row.name?.trim() || row.job_name || "System run",
        owner: NO_OWNER
      }
    case null:
      return {
        kind: "execution",
        label: "Agent",
        title: row.name?.trim() || "Run transcript",
        owner:
          row.parent_session_id === null
            ? NO_OWNER
            : {
                kind: "session",
                id: row.parent_session_id,
                name: row.parent_name?.trim() || "Parent chat"
              }
      }
  }
}
