import { Effect } from "effect"
import type { SessionHistoryHeader } from "./model.js"
import { SessionQueryError, type SessionQueries, type SessionQueryFailure } from "./queries.js"

export const spawnClientId = (parentRunId: string, parentToolCallId: string): string =>
  `spawn:${parentRunId}:${parentToolCallId}`

export const sessionLineage = Effect.fn("Sessions.lineage")(function* (
  queries: SessionQueries["Service"],
  sessionId: string
): Effect.fn.Return<ReadonlyArray<SessionHistoryHeader>, SessionQueryFailure> {
  const lineage: SessionHistoryHeader[] = []
  const seen = new Set<string>()
  let next: string | null = sessionId
  while (next !== null) {
    if (seen.has(next) || lineage.length >= 64) {
      return yield* new SessionQueryError({
        operation: "history_header",
        message: "Session lineage is cyclic or too deep"
      })
    }
    seen.add(next)
    const header: SessionHistoryHeader | null = yield* queries.loadHistoryHeader(next)
    if (header === null) {
      return yield* new SessionQueryError({
        operation: "history_header",
        message: "Session lineage is missing"
      })
    }
    lineage.push(header)
    next = header.sessionType === "agent" ? header.parentSessionId : null
  }
  return lineage
})
