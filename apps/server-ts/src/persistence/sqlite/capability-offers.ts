import { RunContextSchema } from "@arden-hq/protocol/effect/runs"
import type { RunContext } from "@arden-hq/protocol/runs"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { candidateConnected, type OfferCandidate } from "../capability-offers/match.js"
import { CapabilityOfferStoreError, type CapabilityOfferStore } from "../capability-offers/store.js"
import { currentIso } from "../../runtime/clock.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"
import { enqueueRunDelivery } from "./work-deliveries.js"

const CandidatesSchema = Schema.Array(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("preset"),
      id: Schema.NonEmptyString,
      title: Schema.NonEmptyString
    }),
    Schema.Struct({
      kind: Schema.Literal("url"),
      url: Schema.NonEmptyString,
      title: Schema.NonEmptyString
    })
  ])
)

interface OfferRow {
  readonly session_id: string
  readonly tool_call_id: string
  readonly run_id: string
  readonly candidates_json: string
  readonly offered_at: string
}

const UNRECORDED: RunContext = { origin: { kind: "unrecorded" }, task: null }

const connectionBody = (server: string, outcome: "connected" | "declined"): string =>
  `<connection_result>${JSON.stringify({
    server,
    outcome,
    instruction:
      outcome === "connected"
        ? `The user connected ${server}. Its tools are available now; continue the task.`
        : `The user chose not to connect ${server}. Continue without it; do not offer it again.`
  })}</connection_result>`

const settle = Effect.fn("CapabilityOffers.settle")(function* (
  sql: SqlClient.SqlClient,
  row: OfferRow,
  outcome: "connected" | "declined",
  server: string,
  at: string
) {
  const latest = yield* sql<{
    readonly run_id: string
  }>`SELECT run_id FROM chat_runs WHERE session_id = ${row.session_id}
    ORDER BY started_at DESC, run_id DESC LIMIT 1`
  if (latest[0]?.run_id !== row.run_id) {
    yield* sql`UPDATE capability_offers SET outcome = 'expired', outcome_at = ${at}
      WHERE session_id = ${row.session_id} AND tool_call_id = ${row.tool_call_id}
        AND outcome IS NULL`
    return false
  }
  const updated = yield* sql`UPDATE capability_offers SET outcome = ${outcome}, outcome_at = ${at}
    WHERE session_id = ${row.session_id} AND tool_call_id = ${row.tool_call_id}
      AND outcome IS NULL RETURNING tool_call_id`
  if (updated.length === 0) return false
  const stored = yield* sql<{
    readonly context: string | null
  }>`SELECT json_extract(metadata_json, '$.run_context') AS context
    FROM chat_runs WHERE run_id = ${row.run_id}`
  const storedContext = stored[0]?.context
  const context =
    storedContext === null || storedContext === undefined
      ? UNRECORDED
      : yield* decodeJson(RunContextSchema, storedContext).pipe(
          Effect.catch(() => Effect.succeed(UNRECORDED))
        )
  yield* enqueueRunDelivery({
    sql,
    eventId: `capability-offer:${row.session_id}:${row.tool_call_id}`,
    now: at,
    subject: outcome === "connected" ? "Connection made" : "Connection declined",
    body: connectionBody(server, outcome),
    payload: {
      kind: "connection",
      sessionId: row.session_id,
      context,
      runIds: [row.run_id],
      questionId: null,
      connection: {
        tool_call_id: row.tool_call_id,
        server,
        outcome,
        offered_at: row.offered_at,
        at
      }
    }
  })
  return true
})

const titlesOf = (candidates: ReadonlyArray<OfferCandidate>): string =>
  candidates.map((candidate) => candidate.title).join(", ")

export const makeCapabilityOfferStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): CapabilityOfferStore["Service"] => {
  const sql = writer.sql
  const now = Effect.sync(currentIso)

  const failed = (message: string) => (cause: unknown) =>
    new CapabilityOfferStoreError({ reason: "storage", message, cause })

  const record: CapabilityOfferStore["Service"]["record"] = (input) =>
    now.pipe(
      Effect.flatMap((at) => {
        const satisfied = input.connected.some(
          (server) => candidateConnected(input.candidates, server) !== undefined
        )
        return writer.run(
          sql`INSERT INTO capability_offers (session_id, tool_call_id, run_id, candidates_json,
          offered_at, outcome, outcome_at)
        VALUES (${input.sessionId}, ${input.toolCallId}, ${input.runId},
          ${JSON.stringify(input.candidates)}, ${at},
          ${satisfied ? "connected" : null}, ${satisfied ? at : null})
        ON CONFLICT(session_id, tool_call_id) DO NOTHING`
        )
      }),
      Effect.mapError(failed("Could not keep the connection offer")),
      Effect.asVoid
    )

  const connected: CapabilityOfferStore["Service"]["connected"] = (server) =>
    writer
      .transact(
        Effect.gen(function* () {
          const at = yield* now
          const open =
            yield* sql<OfferRow>`SELECT session_id, tool_call_id, run_id, candidates_json,
          offered_at FROM capability_offers WHERE outcome IS NULL ORDER BY offered_at`
          const answered: Array<string> = []
          for (const row of open) {
            const candidates = yield* decodeJson(CandidatesSchema, row.candidates_json).pipe(
              Effect.catch(() => Effect.succeed([]))
            )
            const match = candidateConnected(candidates, server)
            if (match === undefined) continue
            if (yield* settle(sql, row, "connected", match.title, at))
              answered.push(row.tool_call_id)
          }
          return answered
        })
      )
      .pipe(Effect.mapError(failed("Could not answer the connection offers")))

  const decline: CapabilityOfferStore["Service"]["decline"] = (input) =>
    writer
      .transact(
        Effect.gen(function* () {
          const at = yield* now
          const rows = yield* sql<OfferRow & { readonly outcome: string | null }>`SELECT session_id,
          tool_call_id, run_id, candidates_json, offered_at, outcome FROM capability_offers
          WHERE session_id = ${input.sessionId} AND tool_call_id = ${input.toolCallId}`
          const row = rows[0]
          if (row === undefined) return "unknown" as const
          if (row.outcome !== null) return "already_answered" as const
          const candidates = yield* decodeJson(CandidatesSchema, row.candidates_json).pipe(
            Effect.catch(() => Effect.succeed([]))
          )
          const settled = yield* settle(sql, row, "declined", titlesOf(candidates) || "it", at)
          return settled ? ("declined" as const) : ("already_answered" as const)
        })
      )
      .pipe(Effect.mapError(failed("Could not decline the connection offer")))

  const list: CapabilityOfferStore["Service"]["list"] = (sessionId) =>
    writer
      .run(
        sql<{
          readonly tool_call_id: string
          readonly outcome: "connected" | "declined" | "expired" | null
          readonly offered_at: string
        }>`SELECT tool_call_id, outcome, offered_at FROM capability_offers
        WHERE session_id = ${sessionId} ORDER BY offered_at`
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            toolCallId: row.tool_call_id,
            outcome: row.outcome,
            offeredAt: row.offered_at
          }))
        ),
        Effect.mapError(failed("Could not read the connection offers"))
      )

  return { record, connected, decline, list }
}
