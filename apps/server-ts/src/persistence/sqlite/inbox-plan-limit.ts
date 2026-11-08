import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { InboxStoreError, type InboxPlanLimitEntry } from "../inbox/store.js"
import { NOTICE_NAMESPACE } from "./limit-settings.js"

export const planLimitNoticeRows = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly state: string
  }>`SELECT state FROM monitor_state WHERE namespace = ${NOTICE_NAMESPACE}`

type StoreOperation = "view" | "mark_read" | "dismiss"

const PlanLimitNoticeSchema = Schema.Struct({
  level: Schema.Literals(["background", "arden", "used_up"]),
  usedPercent: Schema.Number,
  limitPercent: Schema.NullOr(Schema.Number),
  windowSeconds: Schema.Number,
  resetsAt: Schema.String,
  since: Schema.String
})

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
    level: notice.level,
    usedPercent: notice.usedPercent,
    limitPercent: notice.limitPercent ?? undefined,
    windowSeconds: notice.windowSeconds,
    resetsAt: notice.resetsAt
  }
  return [entry]
})
