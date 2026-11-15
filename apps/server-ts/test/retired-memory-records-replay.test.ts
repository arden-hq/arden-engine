// Opens the replay copy named by ARDEN_REPLAY_COPY with today's migrations, then decodes every
// stored run Memory record and every stored Space review input with today's schemas, which no
// longer translate retired values. Skips when the variable is unset; prints and asserts counts.

import { RunMemoryContextSchema } from "@arden-hq/protocol/effect/runs"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { SpaceReviewInputSchema } from "../src/persistence/automations/space-review.js"
import { locateReplayCopy, runOnReplayCopy } from "./fixtures/replay-copy.js"

const located = locateReplayCopy()

const decodes =
  <A>(schema: Schema.Codec<A, unknown>) =>
  (json: string): boolean =>
    Schema.decodeUnknownOption(Schema.fromJsonString(schema))(json)._tag === "Some"

it("every stored Memory record and Space review input decodes as stored", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const counts = await runOnReplayCopy(
    located.copy,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const column = (rows: ReadonlyArray<{ readonly json: string }>) => rows.map((row) => row.json)
      const records = column(
        yield* sql<{
          readonly json: string
        }>`SELECT context_manifest_json AS json FROM run_sidecars`
      )
      const inputs = [
        ...column(
          yield* sql<{ readonly json: string }>`SELECT input_json AS json FROM automation_runs
            WHERE purpose = 'space_review' AND input_json IS NOT NULL`
        ),
        ...column(
          yield* sql<{
            readonly json: string
          }>`SELECT reviewed_input AS json FROM space_review_checkpoints`
        ),
        ...column(
          yield* sql<{ readonly json: string }>`SELECT json_extract(context, '$.space_review_input')
            AS json FROM automation_event_queue
            WHERE json_extract(context, '$.space_review_input') IS NOT NULL`
        )
      ]
      const record = decodes(Schema.Array(RunMemoryContextSchema))
      const input = decodes(SpaceReviewInputSchema)
      return {
        records: records.length,
        recordsNotDecoded: records.filter((json) => !record(json)).length,
        inputs: inputs.length,
        inputsNotDecoded: inputs.filter((json) => !input(json)).length,
        residentLeft: inputs.filter((json) => json.includes('"basis":"resident"')).length
      }
    })
  )
  process.stdout.write(
    `Run Memory records: ${counts.records}, not decoded ${counts.recordsNotDecoded}. ` +
      `Space review inputs: ${counts.inputs}, not decoded ${counts.inputsNotDecoded}, ` +
      `with a resident page ${counts.residentLeft}.\n`
  )
  expect({
    recordsNotDecoded: counts.recordsNotDecoded,
    inputsNotDecoded: counts.inputsNotDecoded,
    residentLeft: counts.residentLeft
  }).toEqual({ recordsNotDecoded: 0, inputsNotDecoded: 0, residentLeft: 0 })
})
