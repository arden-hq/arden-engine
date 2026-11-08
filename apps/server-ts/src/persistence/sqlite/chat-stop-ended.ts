import { CancelInputSchema } from "@arden-hq/protocol/effect/chat"
import { DateTime, Effect } from "effect"
import type { ChatWriteStore } from "../chat/store.js"
import { mapFailure, validateInput } from "./chat-write-errors.js"
import type { PersistenceDeps } from "./deps.js"
import { fenceRunCancellation } from "./run-cancellation.js"
import { runOwnsLiveWork } from "./run-liveness.js"
import { activeRunStatusList } from "./status-sets.js"

export const makeStopEndedWork = ({
  writer,
  sessionEvents
}: Pick<PersistenceDeps, "writer" | "sessionEvents">): Pick<
  ChatWriteStore["Service"],
  "stopEndedWork"
> => {
  const sql = writer.sql
  const stopEndedWork: ChatWriteStore["Service"]["stopEndedWork"] = Effect.fn(
    "SqliteChatWriteStore.stopEndedWork"
  )(function* (input) {
    yield* validateInput(CancelInputSchema, input, "cancel")
    const now = DateTime.formatIso(yield* DateTime.now)
    const target =
      input.runId !== undefined
        ? sql`run_id = ${input.runId}`
        : sql`session_id = ${input.sessionId}`
    return yield* writer
      .transactInteractive(
        Effect.gen(function* () {
          const ended = yield* sql<{ readonly run_id: string }>`
            SELECT run_id FROM chat_runs
            WHERE ${target} AND status NOT IN ${activeRunStatusList}
              AND ${runOwnsLiveWork(sql, sql`chat_runs.run_id`)}
            ORDER BY run_id`
          const descendantRunIds: Array<string> = []
          for (const run of ended) {
            const fenced = yield* fenceRunCancellation({
              sql,
              sessionEvents,
              runId: run.run_id,
              now
            })
            descendantRunIds.push(...fenced.activeRunIds)
          }
          return { runIds: ended.map((run) => run.run_id), descendantRunIds }
        })
      )
      .pipe(
        Effect.mapError(
          mapFailure("cancel", {
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId })
          })
        )
      )
  })
  return { stopEndedWork }
}
