import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { serializeOperationalCause } from "../../runtime/operational-events.js"
import { TELL_LIMIT, TELL_TEXT_LIMIT, type TellOutcome } from "../work/store.js"
import { doorOf, placeOfRun, tellShown, workerNames } from "./run-ending.js"
import { tellChat, updateWeight } from "./owner-update.js"
import { enqueueRunDelivery } from "./work-deliveries.js"

const NOWHERE = "No one can hear this run right now, so there is nowhere to tell. Carry on."
const OWN_CHAT = "This run's reply goes to this same chat. Write it there instead."

export const recordTell = Effect.fn("RunTell.record")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly runId: string; readonly toolCallId: string; readonly text: string }
): Effect.fn.Return<TellOutcome, SqlError> {
  const text = input.text.trim()
  if (text === "")
    return { kind: "refused", reason: "There is nothing to tell. Say it in a sentence." }
  if (text.length > TELL_TEXT_LIMIT)
    return {
      kind: "refused",
      reason: `That is too long to tell (over ${TELL_TEXT_LIMIT} characters). Say it in one or two sentences.`
    }
  const known = yield* sql<{ readonly n: number; readonly place: string | null }>`SELECT n, place
    FROM run_tells WHERE run_id = ${input.runId} AND tool_call_id = ${input.toolCallId}`
  if (known[0] !== undefined)
    return { kind: "again", n: known[0].n, chatId: known[0].place ?? undefined }
  const placed = yield* placeOfRun(sql, input.runId)
  if (placed === undefined) return { kind: "refused", reason: NOWHERE }
  const { place } = placed
  if (place.kind === "own") return { kind: "refused", reason: OWN_CHAT }
  if (place.kind !== "chat" && place.kind !== "parent") return { kind: "refused", reason: NOWHERE }
  const count =
    (yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM run_tells
    WHERE run_id = ${input.runId}`)[0]?.count ?? 0
  if (count >= TELL_LIMIT)
    return {
      kind: "refused",
      reason: `You have already told ${TELL_LIMIT} things in this run. Put the rest in your final reply.`
    }
  const n = count + 1
  const now = DateTime.formatIso(yield* DateTime.now)
  const shown = tellShown({ purpose: placed.purpose, placeKind: place.kind })
  yield* sql`INSERT INTO run_tells (run_id, n, tool_call_id, text, place, place_kind, occurred_at,
      shown, delivery_error)
    VALUES (${input.runId}, ${n}, ${input.toolCallId}, ${text}, ${place.sessionId}, ${place.kind},
      ${now}, ${shown ? 1 : 0}, NULL)`
  const key = `tell:${input.runId}:${n}`
  const delivered = Effect.gen(function* () {
    if (place.kind === "parent") {
      if (placed.context === undefined || placed.agent === undefined)
        return yield* Effect.fail(new Error("The worker has no parent to tell"))
      yield* enqueueRunDelivery({
        sql,
        eventId: key,
        subject: `${workerNames[placed.agent.mode]} update`,
        body: text,
        payload: {
          kind: "result",
          sessionId: place.sessionId,
          context: placed.context,
          runIds: [input.runId],
          questionId: null,
          progress: true
        },
        now
      })
      return
    }
    if (place.kind !== "chat" || placed.context === undefined || placed.origin === undefined)
      return yield* Effect.fail(new Error("There is no chat to tell"))
    const weight = updateWeight({ kind: "tell", shown })
    if (weight === undefined) return
    yield* tellChat({
      sql,
      weight,
      occurrenceKey: key,
      source: { kind: "tell", runId: input.runId, n },
      sourceRunId: input.runId,
      sourceSessionRef: placed.source.source_ref,
      destination: place.row,
      line: text,
      door: yield* doorOf(sql, placed.origin, placed.source, placed.context),
      event: "told",
      occurredAt: now
    })
  })
  yield* delivered.pipe(
    Effect.catch(
      (cause) =>
        sql`UPDATE run_tells SET delivery_error = ${serializeOperationalCause(cause)}
          WHERE run_id = ${input.runId} AND n = ${n}`
    ),
    Effect.catchDefect(
      (defect) =>
        sql`UPDATE run_tells SET delivery_error = ${serializeOperationalCause(defect)}
          WHERE run_id = ${input.runId} AND n = ${n}`
    )
  )
  return { kind: "told", n, left: TELL_LIMIT - n, chatId: place.sessionId }
})
