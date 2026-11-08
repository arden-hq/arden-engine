import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  planActiveContext,
  stageActiveContextChunk,
  type StagePlan
} from "./active-context-stage.js"
import type { PreparedBackfill } from "./backfills/backfill.js"

interface Cursor {
  readonly sessionId: string
  readonly seq: number | null
  readonly epoch: number
}

const parseCursor = (text: string | undefined): Cursor | null => {
  if (text === undefined) return null
  const value: unknown = JSON.parse(text)
  if (
    value === null ||
    typeof value !== "object" ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("seq" in value) ||
    (value.seq !== null && (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq))) ||
    !("epoch" in value) ||
    typeof value.epoch !== "number" ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0
  )
    throw new Error("Invalid active-context staged backfill cursor")
  return { sessionId: value.sessionId, seq: value.seq, epoch: value.epoch }
}

const cursorOf = (sessionId: string, seq: number | null, epoch = 0): string =>
  JSON.stringify({ sessionId, seq, epoch })

export const activeContextStagedBackfill: PreparedBackfill = (() => {
  const plans = new WeakMap<SqlClient.SqlClient, StagePlan>()
  return {
    name: "active_context_window_staged",
    prepare: Effect.fn("ActiveContext.backfillPrepare")(function* ({ cursor, limit, reader }) {
      const after = parseCursor(cursor)
      const next = (yield* reader<{ readonly session_id: string }>`
        SELECT session_id FROM sessions
        WHERE context_from_seq IS NULL
          AND (session_id > ${after?.sessionId ?? ""}
            OR (session_id = ${after?.sessionId ?? ""} AND ${after !== null && after.seq !== null ? 1 : 0}))
        ORDER BY session_id LIMIT 1
      `)[0]
      if (next === undefined) {
        return Effect.succeed({ converted: 0, next: undefined })
      }
      const sessionId = next.session_id
      let plan = plans.get(reader)
      if (plan?.sessionId !== sessionId) {
        const prepared = yield* reader
          .withTransaction(planActiveContext(reader, sessionId))
          .pipe(
            Effect.catchTag("ActiveContextError", (error) =>
              error.reason === "corrupt" ? Effect.succeed(null) : Effect.fail(error)
            )
          )
        if (prepared === null) {
          plans.delete(reader)
          return Effect.succeed({ converted: 0, next: cursorOf(sessionId, null) })
        }
        plan = prepared
        plans.set(reader, plan)
      }
      return Effect.fn("ActiveContext.backfillStage")(function* () {
        const sql = yield* SqlClient.SqlClient
        const step = yield* stageActiveContextChunk(sql, plan, limit)
        if (step.lastSeq === -1 && !step.converted) {
          plans.delete(reader)
          return { converted: 0, next: cursorOf(sessionId, -1, (after?.epoch ?? 0) + 1) }
        }
        if (step.converted) plans.delete(reader)
        return {
          converted: step.converted ? 1 : 0,
          next: cursorOf(
            sessionId,
            step.converted ? null : step.lastSeq,
            step.lastSeq === -2 ? (after?.epoch ?? 0) + 1 : (after?.epoch ?? 0)
          )
        }
      })()
    }),
    remaining: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM sessions WHERE context_from_seq IS NULL
      `
      return rows[0]?.n ?? 0
    })
  }
})()
