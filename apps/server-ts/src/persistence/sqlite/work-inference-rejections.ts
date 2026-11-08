import type { SpaceTaskSource } from "@arden-hq/protocol/spaces/work"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { taskSourceKey } from "./work-sources.js"
import { workError } from "./work-records.js"
import { sha256Hex } from "@arden-hq/std/hash"

const inferenceEvidenceKey = (sources: ReadonlyArray<SpaceTaskSource>): string =>
  sha256Hex(JSON.stringify([...new Set(sources.map(taskSourceKey))].sort()))

export const assertInferenceNotRejected = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  spaceId: string,
  sources: ReadonlyArray<SpaceTaskSource>
) {
  if (sources.length === 0)
    return yield* workError("invalid", "Inferred Tasks require source evidence")
  const rejected = yield* sql`SELECT 1 FROM task_inference_rejections
    WHERE space_id = ${spaceId} AND evidence_key = ${inferenceEvidenceKey(sources)} LIMIT 1`.pipe(
    Effect.mapError((cause) =>
      workError("storage", "Could not check rejected inference evidence", cause)
    )
  )
  if (rejected.length > 0)
    return yield* workError("conflict", "You rejected a Task inferred from this unchanged evidence")
})
