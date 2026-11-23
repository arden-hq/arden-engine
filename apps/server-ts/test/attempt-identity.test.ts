import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { taskJobId } from "../src/persistence/space-job-id.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { startJob } from "./fixtures/job-runs.js"
import {
  LATER,
  type AttemptCorruption,
  type Lease,
  claim,
  corruptAttempt,
  makeTask,
  tryClaim,
  tryRenew
} from "./work-fixtures.js"

const ITEM = "work:space-1:background"

const admit = (lease: Lease, id: string) =>
  startJob(lease, id).pipe(
    Effect.match({
      onFailure: () => "refused",
      onSuccess: () => "started"
    })
  )

const shown = (
  outcome: Effect.Success<ReturnType<typeof tryRenew>> | Effect.Success<ReturnType<typeof tryClaim>>
) => (outcome.kind === "refused" ? "refused" : "done")

const cases: ReadonlyArray<readonly [string, AttemptCorruption]> = [
  ["no purpose", { kind: "purpose", purpose: null }],
  ["an Automation's purpose", { kind: "purpose", purpose: "user_automation" }],
  [
    "an Automation's origin",
    {
      kind: "origin",
      origin: { kind: "automation", automation_id: taskJobId(ITEM), occurrence_id: "made-up" }
    }
  ],
  [
    "the origin of another Task",
    {
      kind: "origin",
      origin: { kind: "task", item_id: "work:space-1:other", occurrence_id: "made-up" }
    }
  ],
  ["no recorded origin", { kind: "origin", origin: { kind: "unrecorded" } }],
  ["no Task binding", { kind: "unbound" }]
]

it.each(cases)(
  "a Task attempt stored with %s is refused before any work",
  async (_name, corruption) => {
    const outcome = await withTempDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* makeTask
        const [lease] = yield* claim("first", 10)
        if (lease === undefined) throw new Error("The Task was not claimed")
        yield* corruptAttempt(lease.payload.automationRunId, corruption)
        const renewed = yield* tryRenew(lease, LATER + 1_000)
        const admitted = yield* admit(lease, "corrupt-run")
        const reclaimed = yield* tryClaim("second", LATER + 10 * 60_000)
        const [runs] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM chat_runs`
        const attempts = yield* sql<{ readonly status: string; readonly claim_count: number }>`
          SELECT status, claim_count FROM automation_runs
          WHERE id = ${lease.payload.automationRunId}`
        return {
          renewed: shown(renewed),
          admitted,
          reclaimed: shown(reclaimed),
          chatRuns: runs?.n,
          attempts
        }
      })
    )
    expect(outcome).toEqual({
      renewed: "refused",
      admitted: "refused",
      reclaimed: "refused",
      chatRuns: 0,
      attempts: [{ status: "running", claim_count: 1 }]
    })
  }
)

it("a sound Task attempt renews, comes back after its lease and is admitted, as a Task's", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const task = yield* makeTask
      const key = taskJobId(task.item_id)
      const [lease] = yield* claim("first", 10)
      if (lease === undefined) throw new Error("The Task was not claimed")
      const renewed = yield* tryRenew(lease, LATER + 1_000)
      if (renewed.kind === "refused") throw new Error(`Not renewed: ${renewed.message}`)
      const [reclaimed] = yield* claim("second", 10, renewed.value.expiresAt + 1)
      if (reclaimed === undefined) throw new Error("The expired claim did not come back")
      const admitted = yield* admit(reclaimed, "sound-run")
      const origins = yield* sql<{ readonly kind: string; readonly item_id: string }>`
        SELECT json_extract(metadata_json, '$.run_context.origin.kind') AS kind,
          json_extract(metadata_json, '$.run_context.task.item_id') AS item_id
        FROM chat_runs`
      return {
        first: [lease.payload.automationId === key, lease.payload.purpose],
        renewed: [renewed.value.token === lease.token, renewed.value.payload.purpose],
        reclaimed: [
          reclaimed.payload.automationRunId === lease.payload.automationRunId,
          reclaimed.token === lease.token,
          reclaimed.payload.purpose,
          reclaimed.payload.sessionId === lease.payload.sessionId
        ],
        admitted,
        origins
      }
    })
  )
  expect(outcome).toEqual({
    first: [true, "task_execution"],
    renewed: [true, "task_execution"],
    reclaimed: [true, false, "task_execution", true],
    admitted: "started",
    origins: [{ kind: "task", item_id: ITEM }]
  })
})
