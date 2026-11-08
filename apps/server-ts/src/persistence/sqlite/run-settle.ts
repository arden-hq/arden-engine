import type { ChatEventStore } from "../events/store.js"
import { Effect } from "effect"
import type { QueueWriter } from "./automation-enqueue.js"
import { recordEnding, type RunTerminal } from "./run-ending.js"
import { applySpaceMoveAtRunEnd } from "./session-space-move.js"
import { announceNotice } from "./notices.js"
import { settleTaskRun } from "./task-next-move.js"
import { recordTaskReport } from "./work-events.js"

export const settleRun = Effect.fn("RunSettle.settle")(function* (
  writer: QueueWriter & { readonly chatEvents: ChatEventStore["Service"] },
  input: {
    readonly runId: string
    readonly terminal: RunTerminal
    readonly now: string
    readonly occurredAt?: string
  }
) {
  const { runId, terminal, now } = input
  yield* recordEnding(writer.sql, {
    kind: "run",
    runId,
    terminal,
    now,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt })
  })
  if (terminal.status === "completed") yield* recordTaskReport(writer, runId)
  yield* settleTaskRun(writer, runId, now)
  const lateMove = yield* applySpaceMoveAtRunEnd({
    sql: writer.sql,
    runId
  })
  if (lateMove !== undefined) {
    const [origin] = yield* writer.sql<{ readonly session_id: string }>`
      SELECT call.session_id FROM tool_calls AS call
      JOIN chat_runs AS ending ON ending.run_id = ${runId}
      WHERE call.run_id = ${lateMove.runId} AND call.tool_call_id = ${lateMove.toolCallId}
        AND call.session_id <> ending.session_id
        AND EXISTS (SELECT 1 FROM session_mutation_links AS link
          WHERE link.run_id = call.run_id AND link.tool_call_id = call.tool_call_id)`
    if (origin !== undefined)
      yield* writer.chatEvents.appendInTransaction({
        sessionId: origin.session_id,
        events: [{ event: { type: "transcript_changed" } }]
      })
  }
  yield* announceNotice(writer.sql, writer.sessionEvents, `ending:${runId}`)
})
