// Replays the owner's past Space reviews through the admission check, with no model and no
// write: each review row's stored input and trigger, read from the database named by
// ARDEN_REVIEW_REPLAY_DB, opened read-only and immutable. It skips when the variable is unset
// or names no file, so the normal suite never reads private data. It prints and asserts counts
// only.
//
//   ARDEN_REVIEW_REPLAY_DB=<path to arden.db> npx vitest run test/space-review-admission-replay.test.ts

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { Schema } from "effect"
import { expect, it } from "vitest"
import { spaceReviewAdmission } from "../src/automations/space-review-admission.js"
import { SpaceReviewInputSchema } from "../src/persistence/automations/space-review.js"

const DATABASE = process.env["ARDEN_REVIEW_REPLAY_DB"]?.trim() ?? ""
// The window the rebuild plan measured: 1,293 review rows, 113 of which did something.
const FROM = "2026-10-14T00:00:00.000Z"
const UNTIL = "2026-11-14T00:00:00.000Z"
const ACTED = new Set(["finished", "needs_you"])
// A review that ran a model and ended with one of these advanced the Space's checkpoint.
const CHECKPOINTED = new Set(["finished", "no_change", "needs_you"])

const TriggerSchema = Schema.fromJsonString(
  Schema.Struct({
    source: Schema.String,
    event_type: Schema.optionalKey(Schema.String),
    causes: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ source: Schema.String, event_type: Schema.optionalKey(Schema.String) })
      )
    )
  })
)
const decodeInput = Schema.decodeUnknownSync(Schema.fromJsonString(SpaceReviewInputSchema))

const RowsSchema = Schema.Array(
  Schema.Struct({
    started_at: Schema.String,
    outcome: Schema.String,
    chat_run_id: Schema.NullOr(Schema.String),
    trigger_json: Schema.String,
    input_json: Schema.String
  })
)

/** The owner asked: a manual run or a proposal recheck, alone or among merged wakes. */
const askedBy = (trigger: string): boolean => {
  const decoded = Schema.decodeUnknownSync(TriggerSchema)(trigger)
  return [decoded, ...(decoded.causes ?? [])].some(
    (cause) => cause.source === "manual" || cause.event_type === "space.proposal_review_requested"
  )
}

it.skipIf(DATABASE === "" || !existsSync(DATABASE))(
  "past Space reviews through the one admission check",
  () => {
    const database = new DatabaseSync(`file:${DATABASE}?mode=ro&immutable=1`, { readOnly: true })
    try {
      const rows = Schema.decodeUnknownSync(RowsSchema)(
        database
          .prepare(
            `SELECT started_at, outcome, chat_run_id, trigger_json, input_json FROM automation_runs
             WHERE purpose = 'space_review' AND input_json IS NOT NULL AND started_at < ?
             ORDER BY started_at, id`
          )
          .all(UNTIL)
      )
      // The checkpoint each review compared with: the frozen input of the Space's last review
      // that ran a model and advanced it.
      const checkpoint = new Map<string, { readonly semantic: string }>()
      const counts = { rows: 0, start: 0, acted: 0, actedStarts: 0 }
      const byOutcome = new Map<string, { started: number; skipped: number }>()
      const actedSkipped = new Map<string, number>()
      for (const row of rows) {
        const input = decodeInput(row.input_json)
        if (row.started_at >= FROM && input.reads !== undefined) {
          const verdict = spaceReviewAdmission(
            { semantic: input.semantic, reads: input.reads },
            checkpoint.get(input.spaceId),
            askedBy(row.trigger_json)
          )
          const starts = verdict.admission === "changed"
          const acted = ACTED.has(row.outcome)
          const outcome =
            row.outcome === "no_change" && row.chat_run_id === null
              ? "no_change, no model run"
              : row.outcome
          const tally = byOutcome.get(outcome) ?? { started: 0, skipped: 0 }
          if (starts) tally.started += 1
          else tally.skipped += 1
          byOutcome.set(outcome, tally)
          counts.rows += 1
          if (starts) counts.start += 1
          if (acted) counts.acted += 1
          if (acted && starts) counts.actedStarts += 1
          if (acted && !starts) {
            const reason = `${verdict.admission}: changed ${[...verdict.changes].join("+") || "nothing"}; holds ${[...verdict.holds].join("+")}`
            actedSkipped.set(reason, (actedSkipped.get(reason) ?? 0) + 1)
          }
        }
        if (row.chat_run_id !== null && CHECKPOINTED.has(row.outcome))
          checkpoint.set(input.spaceId, { semantic: input.semantic })
      }
      process.stdout.write(
        [
          `Review rows ${FROM.slice(0, 10)} to ${UNTIL.slice(0, 10)}: ${counts.rows}; the check starts ${counts.start}.`,
          ...[...byOutcome].map(
            ([outcome, tally]) => `  ${outcome}: ${tally.started} start, ${tally.skipped} do not`
          ),
          `Reviews that did something: ${counts.acted}; the check starts ${counts.actedStarts}.`,
          ...[...actedSkipped].map(([reason, count]) => `  not started, ${reason}: ${count}`),
          ""
        ].join("\n")
      )
      expect(counts.rows).toBe(1293)
      expect(counts.acted).toBe(113)
      // The one review that acted and would not start offered work from Memory pages alone in
      // a Space that held nothing; the owner rejected that offer.
      expect(Object.fromEntries(actedSkipped)).toEqual({
        "nothing_to_act_on: changed memory_page; holds nothing": 1
      })
    } finally {
      database.close()
    }
  }
)
