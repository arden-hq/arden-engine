import { Clock, Effect, Schema } from "effect"
import { HOME_LETTER_AUTOMATION_ID } from "../automations/model.js"
import { AutomationStoreError } from "../automations/store.js"
import { HomeLetterInputs } from "../automations/home-letter-inputs.js"
import { HomeLetterInputSchema } from "../home/model.js"
import { parseLease } from "./automation-lease.js"
import { QueueContextSchema } from "./automation-queue-context.js"
import { decodeJson, encodeJson } from "./json.js"
import type { PersistenceDeps } from "./deps.js"
import { iso } from "../../runtime/clock.js"

export const makeHomeLetterInputs = ({
  writer
}: Pick<PersistenceDeps, "writer">): HomeLetterInputs["Service"] => {
  const sql = writer.sql
  const freezeHomeInput: HomeLetterInputs["Service"]["freezeHomeInput"] = Effect.fn(
    "HomeLetterInputs.freezeHomeInput"
  )(function* (lease, input) {
    const parsed = parseLease(lease)
    const error = (reason: AutomationStoreError["reason"], message: string, cause?: unknown) =>
      new AutomationStoreError({
        operation: "prepare_home_letter",
        reason,
        message,
        automationId: lease.payload.automationId,
        ...(cause === undefined ? {} : { cause })
      })
    if (lease.payload.handler !== "home_letter")
      return yield* error("invalid", "Only Home Automation owns letter inputs")
    const valid = yield* Schema.decodeUnknownEffect(HomeLetterInputSchema)(input).pipe(
      Effect.mapError((cause) => error("invalid", "Invalid Home input", cause))
    )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly context: string
          }>`SELECT queue.context FROM automation_event_queue AS queue
        JOIN automation_runs AS run ON run.id = ${parsed.runId} AND run.task_id = queue.task_id
        WHERE queue.id = ${parsed.queueId} AND queue.lease_expires_at > ${iso(yield* Clock.currentTimeMillis)}
          AND queue.claimed_at IS NOT NULL AND run.claim_count = ${parsed.claimAttempt}
          AND queue.task_id = ${HOME_LETTER_AUTOMATION_ID} AND run.status = 'running'
          AND json_extract(queue.context, '$.automation_run_id') = ${parsed.runId}`
          if (!rows[0])
            return yield* error("conflict", "Home generation lease is no longer current")
          const context = yield* decodeJson(QueueContextSchema, rows[0].context)
          const frozen = context.home_letter_input ?? valid
          const durable = yield* encodeJson(HomeLetterInputSchema, frozen)
          yield* sql`UPDATE automation_runs SET input_json = COALESCE(input_json, ${durable}) WHERE id = ${parsed.runId}`
          if (context.home_letter_input !== undefined) return context.home_letter_input
          const encoded = yield* encodeJson(QueueContextSchema, {
            ...context,
            home_letter_input: valid
          })
          yield* sql`UPDATE automation_event_queue SET context = ${encoded}
        WHERE id = ${parsed.queueId} AND claimed_at IS NOT NULL`
          return valid
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : error("storage", "Could not save Home generation input", cause)
        )
      )
  })
  return HomeLetterInputs.of({ freezeHomeInput })
}
