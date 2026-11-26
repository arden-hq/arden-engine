import { Effect, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import {
  RECORDED_HISTORY_ENTRY_KIND,
  RECORDED_HISTORY_NEXT,
  RECORDED_HISTORY_THROUGH,
  RecordedHistoryEntrySchema,
  RecordedHistoryQuerySchema,
  type RecordedHistoryInput,
  type RecordedHistoryPage
} from "../history.js"
import { RecordedHistoryError } from "../history.js"
import type { PersistenceDeps } from "./deps.js"

export const readRecordedHistory = Effect.fn("RecordedHistory.read")(
  function* (
    sql: SqlClient.SqlClient,
    kind: keyof typeof historyTables,
    input: RecordedHistoryInput
  ): Effect.fn.Return<
    RecordedHistoryPage,
    RecordedHistoryError | SqlError.SqlError | Schema.SchemaError
  > {
    const query = yield* Schema.decodeUnknownEffect(RecordedHistoryQuerySchema)(input).pipe(
      Effect.mapError(
        (cause) =>
          new RecordedHistoryError({ reason: "invalid", message: "Invalid history window", cause })
      )
    )
    const selectedTable = historyTables[kind]
    const table = sql.literal(selectedTable.history)
    const owner = sql.literal(selectedTable.owner)
    const key = sql.literal(selectedTable.key)
    const scope = sql.literal("scope" in selectedTable ? selectedTable.scope : "1")
    const exists = yield* sql`SELECT 1 FROM ${owner} WHERE ${key} = ${input.id} AND ${scope}`
    if (exists.length === 0)
      return yield* new RecordedHistoryError({
        reason: "not_found",
        message: "History owner no longer exists"
      })
    const [head] = yield* sql<{
      readonly version: number
    }>`SELECT COALESCE(MAX(version), 0) AS version FROM ${table} WHERE ${key} = ${input.id}`
    const through =
      query.through === RECORDED_HISTORY_THROUGH.version
        ? query.through_version
        : (head?.version ?? 0)
    const after = query.after_version
    if (after > through || through > (head?.version ?? 0))
      return yield* new RecordedHistoryError({
        reason: "invalid",
        message: "History cursor is outside this entity's history"
      })
    const first = yield* sql<{
      readonly kind: string
    }>`SELECT kind FROM ${table} WHERE ${key} = ${input.id} AND version = 1`
    const state = sql.literal("state" in selectedTable ? selectedTable.state : "state_json")
    const rows = yield* sql<{
      readonly version: number
      readonly kind: string
      readonly recorded_at: string
      readonly state_json: string
    }>`
    SELECT version, kind, recorded_at, ${state} AS state_json FROM ${table}
    WHERE ${key} = ${input.id} AND version > ${after} AND version <= ${through}
    ORDER BY version LIMIT ${query.limit + 1}`
    const selected = rows.slice(0, query.limit)
    const entries = yield* Effect.forEach(selected, ({ state_json, ...row }) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
        state_json
      ).pipe(
        Effect.flatMap((state) =>
          Schema.decodeUnknownEffect(RecordedHistoryEntrySchema)({ ...row, state })
        )
      )
    )
    let coverage: RecordedHistoryPage["coverage"] = "pending_baseline"
    if (first[0]?.kind === RECORDED_HISTORY_ENTRY_KIND.created) coverage = "from_creation"
    if (first[0]?.kind === RECORDED_HISTORY_ENTRY_KIND.baseline) coverage = "from_baseline"
    return {
      entries,
      through_version: through,
      next: nextPage(rows.length > selected.length, selected.at(-1)?.version),
      coverage
    }
  },
  Effect.mapError((cause) =>
    cause instanceof RecordedHistoryError
      ? cause
      : new RecordedHistoryError({
          reason: "storage",
          message: "Could not read recorded history",
          cause
        })
  )
)

const nextPage = (more: boolean, last: number | undefined): RecordedHistoryPage["next"] =>
  more && last !== undefined
    ? { kind: RECORDED_HISTORY_NEXT.more, after_version: last }
    : { kind: RECORDED_HISTORY_NEXT.end }

const historyTables = {
  task: { owner: "space_tasks", history: "space_task_revisions", key: "item_id" },
  proposal: { owner: "task_proposals", history: "task_proposal_revisions", key: "proposal_id" },
  space: { owner: "spaces", history: "space_revisions", key: "space_id" },
  session: { owner: "sessions", history: "session_revisions", key: "session_id" },
  automation: {
    owner: "scheduled_tasks",
    history: "automation_configuration_revisions",
    key: "task_id",
    scope: "purpose = 'user_automation' AND builtin = 0",
    state:
      "json_set(state_json, '$.instruction', json((SELECT instruction_json FROM automation_instruction_revisions WHERE revision_id = json_extract(state_json, '$.instruction_revision_id') AND task_id = automation_configuration_revisions.task_id)))"
  }
} as const

export const recordedHistoryReader =
  (
    { writer, reader }: Pick<PersistenceDeps, "writer" | "reader">,
    kind: keyof typeof historyTables
  ): ((input: RecordedHistoryInput) => Effect.Effect<RecordedHistoryPage, RecordedHistoryError>) =>
  (input) =>
    writer.snapshot(readRecordedHistory(reader, kind, input)).pipe(
      Effect.mapError((cause) =>
        cause instanceof RecordedHistoryError
          ? cause
          : new RecordedHistoryError({
              reason: "storage",
              message: "Could not open history snapshot",
              cause
            })
      )
    )
