import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { InboxStoreError, type InboxPlanLimitEntry } from "../inbox/store.js"
import { NOTICE_NAMESPACE } from "./limit-settings.js"
import type { Statement } from "effect/unstable/sql/Statement"

export const planLimitNoticeRows = (
  sql: SqlClient.SqlClient
): Statement<{ readonly state: string }> =>
  sql<{
    readonly state: string
  }>`SELECT state FROM monitor_state WHERE namespace = ${NOTICE_NAMESPACE}`

type StoreOperation = "view" | "mark_read" | "dismiss"

const noticeFields = {
  usedPercent: Schema.Number,
  windowSeconds: Schema.Number,
  resetsAt: Schema.String,
  since: Schema.String
} as const

const PlanLimitNoticeSchema = Schema.Union([
  Schema.Struct({ ...noticeFields, level: Schema.Literal("used_up"), limitPercent: Schema.Null }),
  Schema.Struct({
    ...noticeFields,
    level: Schema.Literals(["background", "arden"]),
    limitPercent: Schema.Number
  })
])

export const planLimitEntries = Effect.fn("SqliteInbox.planLimitEntries")(function* (
  operation: StoreOperation,
  stored: string | undefined,
  marks: ReadonlyMap<string, string>,
  unread: (at: string, readAt: string | undefined) => boolean
) {
  if (stored === undefined) return [] as ReadonlyArray<InboxPlanLimitEntry>
  const notice = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PlanLimitNoticeSchema))(
    stored
  ).pipe(
    Effect.mapError(
      (cause) =>
        new InboxStoreError({
          operation,
          reason: "storage",
          message: "Stored plan limit notice is corrupt",
          cause
        })
    )
  )
  const key = `plan_limit:${notice.level}:${notice.resetsAt}`
  const entry: InboxPlanLimitEntry = {
    source: "plan_limit",
    key,
    groupKey: "limits",
    at: notice.since,
    counted: true,
    unread: unread(notice.since, marks.get(key)),
    readAt: marks.get(key),
    reached:
      notice.limitPercent === null
        ? { level: notice.level }
        : { level: notice.level, limit_percent: notice.limitPercent },
    usedPercent: notice.usedPercent,
    windowSeconds: notice.windowSeconds,
    resetsAt: notice.resetsAt
  }
  return [entry]
})
