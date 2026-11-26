import { Effect } from "effect"
import type { WorkStore } from "../work/store.js"
import type { PersistenceDeps } from "./deps.js"
import { recordTell } from "./run-tell.js"
import { readRunTaskContext, readTaskWorkerContext } from "./space-job-context.js"
import { readTaskIntent } from "./task-plan.js"
import { workError } from "./work-records.js"

export const makeTaskContextReads = ({
  writer
}: Pick<PersistenceDeps, "writer">): Pick<
  WorkStore["Service"],
  "continuationContext" | "taskContext" | "taskIntent" | "tell"
> => {
  const sql = writer.sql
  return {
    continuationContext: (runId) =>
      readRunTaskContext(sql, runId).pipe(
        Effect.mapError((cause) => workError("storage", "Could not read Task continuation", cause))
      ),
    taskContext: (itemId) =>
      readTaskWorkerContext(sql, itemId).pipe(
        Effect.mapError((cause) => workError("storage", "Could not read Task context", cause))
      ),
    taskIntent: (itemId) =>
      readTaskIntent(sql, itemId).pipe(
        Effect.mapError((cause) => workError("storage", "Could not read the Task's request", cause))
      ),
    tell: (input) =>
      writer
        .transact(recordTell(sql, input))
        .pipe(Effect.mapError((cause) => workError("storage", "Could not record the tell", cause)))
  }
}
