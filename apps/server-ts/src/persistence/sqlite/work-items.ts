import type { SpaceTask, SpaceTaskSource } from "@arden-hq/protocol/spaces/work"
import { SpaceTaskCaptureSchema, SpaceTaskSchema } from "@arden-hq/protocol/effect/spaces/work"
import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { WorkStoreError } from "../work/store.js"
import { decodeJson } from "./json.js"
import { taskRevisionRef } from "./work-history.js"
import { readTaskState } from "../work/task-state.js"

export interface WorkItemRow {
  readonly history_revision: string | null
  readonly item_id: string
  readonly space_id: string | null
  readonly home_session_id: string | null
  readonly stable_key: string
  readonly text: string
  readonly body: string | null
  readonly status: string
  readonly owner: string
  readonly runs_in: string
  readonly token_budget: number | null
  readonly blocked: number
  readonly waiting_on: string | null
  readonly due_at: string | null
  readonly next_attempt_at: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly completed_at: string | null
  readonly created_by: string | null
  readonly seq: number | null
  readonly block_count: number
  readonly capture: string
  readonly contract_json: string
  readonly state_json: string | null
}

const WORK_ITEM_COLUMNS: ReadonlyArray<
  Exclude<keyof WorkItemRow, "history_revision" | "contract_json" | "state_json">
> = [
  "item_id",
  "space_id",
  "home_session_id",
  "stable_key",
  "text",
  "body",
  "status",
  "owner",
  "runs_in",
  "token_budget",
  "blocked",
  "waiting_on",
  "due_at",
  "next_attempt_at",
  "created_at",
  "updated_at",
  "completed_at",
  "created_by",
  "seq",
  "block_count",
  "capture"
]

export const workItemColumns = (sql: SqlClient.SqlClient, alias?: string): Statement.Fragment => {
  const itemId = sql.literal(`${alias ?? "space_tasks"}.item_id`)
  return sql`${sql.literal(
    WORK_ITEM_COLUMNS.map((column) => (alias === undefined ? column : `${alias}.${column}`)).join(
      ", "
    )
  )}, ${taskRevisionRef(
    sql,
    itemId,
    sql`(SELECT MAX(version) FROM space_task_revisions WHERE item_id = ${itemId})`
  )} AS history_revision, ${contractLinesSql(sql, itemId)} AS contract_json, ${sql.literal(
    alias === undefined ? "continuation_context" : `${alias}.continuation_context`
  )} AS state_json`
}

const contractLinesSql = (sql: SqlClient.SqlClient, itemId: Statement.Fragment) =>
  sql`(SELECT json_group_array(json(CASE line.kind
      WHEN 'rule' THEN json_object('line_id', line.line_id, 'kind', line.kind, 'text', line.text)
      WHEN 'criterion' THEN json_object('line_id', line.line_id, 'kind', line.kind,
        'text', line.text, 'met', json(json_extract(line.evidence_json, '$[#-1]')))
      ELSE json_object('line_id', line.line_id, 'kind', line.kind, 'text', line.text,
        'rejected', line.rejected) END))
    FROM (SELECT line_id, kind, text, rejected, evidence_json FROM task_contract_lines
      WHERE item_id = ${itemId} AND retired_at IS NULL ORDER BY line_id) AS line)`

const ContractJsonSchema = Schema.fromJsonString(Schema.Array(Schema.Unknown))

export const decodeWorkItem = Effect.fn("SqliteWorkStore.decodeWorkItem")(function* (
  row: WorkItemRow,
  sources: ReadonlyArray<SpaceTaskSource>,
  state: Pick<SpaceTask, "activity" | "hold" | "stop_reason" | "stop_kind"> = {
    activity: "idle",
    hold: null,
    stop_reason: null,
    stop_kind: null
  }
): Effect.fn.Return<SpaceTask, WorkStoreError> {
  const { contract_json: contractJson, state_json: stateJson, ...fields } = row
  const record = yield* readTaskState(stateJson)
  const stateRecord =
    record === undefined
      ? null
      : {
          done: record.done,
          in_progress: record.in_progress,
          decided: record.decided,
          rejected: record.rejected,
          next: record.next,
          written_at: record.written_at
        }
  return yield* Schema.decodeUnknownEffect(SpaceTaskSchema)({
    ...fields,
    contract: yield* Schema.decodeUnknownEffect(ContractJsonSchema)(contractJson).pipe(
      Effect.mapError(
        (cause) =>
          new WorkStoreError({
            reason: "storage",
            message: "Stored Task contract is corrupt",
            cause
          })
      )
    ),
    state: stateRecord,
    sources,
    ...state,
    capture: yield* decodeJson(SpaceTaskCaptureSchema, row.capture).pipe(
      Effect.mapError(
        (cause) =>
          new WorkStoreError({
            reason: "storage",
            message: "Stored Task capture is corrupt",
            cause
          })
      )
    ),
    blocked: yield* Schema.decodeUnknownEffect(Schema.Literals([0, 1] as const))(row.blocked).pipe(
      Effect.map((value) => value === 1),
      Effect.mapError(
        (cause) =>
          new WorkStoreError({
            reason: "storage",
            message: "Stored work item blocked flag must be 0 or 1",
            cause
          })
      )
    )
  }).pipe(
    Effect.mapError(
      (cause) =>
        new WorkStoreError({
          reason: "storage",
          message: "Stored Space work item is corrupt",
          cause
        })
    )
  )
})
