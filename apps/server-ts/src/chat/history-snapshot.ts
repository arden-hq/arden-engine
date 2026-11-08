import type { HistoryRouteOptions, TurnWorkRouteOptions } from "@arden-hq/protocol/chat"
import { isForegroundRunStatus } from "@arden-hq/protocol/runs"
import { Effect, Schedule, Schema } from "effect"
import type { ChatEventStore } from "../persistence/events/store.js"
import type { RunQueries } from "../persistence/runs/queries.js"
import type { TranscriptPage } from "../persistence/transcript/model.js"
import type {
  TranscriptQueries,
  TranscriptQueryFailure
} from "../persistence/transcript/queries.js"
import { ChatHistoryError, ChatHistoryInvalidCursor } from "./history-errors.js"
import { historyToolCallIds } from "./history-projection.js"

class HistorySnapshotChanged extends Schema.TaggedError<HistorySnapshotChanged>()(
  "HistorySnapshotChanged",
  {
    before: Schema.Int,
    after: Schema.Int
  }
) {}

const loadPage = Effect.fn("ChatHistory.loadPage")(function* (
  transcript: TranscriptQueries["Service"],
  sessionId: string,
  input: HistoryRouteOptions
): Effect.fn.Return<TranscriptPage, TranscriptQueryFailure | ChatHistoryInvalidCursor> {
  const limit = input.limit ?? 100
  if (input.aroundSeq !== undefined) {
    return yield* transcript.conversationPage({
      _tag: "Around",
      sessionId,
      limit,
      sequence: input.aroundSeq
    })
  }

  const cursor = input.around ?? input.before ?? input.after
  if (cursor === undefined) {
    return yield* transcript.conversationPage({ _tag: "Latest", sessionId, limit })
  }

  const sequence = yield* input.around === undefined
    ? transcript.resolveConversationReference(sessionId, cursor)
    : transcript.resolveReference(sessionId, cursor)
  if (sequence === null) {
    return yield* new ChatHistoryInvalidCursor({ sessionId, cursor })
  }
  if (input.around !== undefined) {
    return yield* transcript.conversationPage({ _tag: "Around", sessionId, limit, sequence })
  }
  if (input.before !== undefined) {
    return yield* transcript.conversationPage({ _tag: "Before", sessionId, limit, sequence })
  }
  return yield* transcript.conversationPage({ _tag: "After", sessionId, limit, sequence })
})

const loadTurnWorkPage = Effect.fn("ChatHistory.loadTurnWorkPage")(function* (
  transcript: TranscriptQueries["Service"],
  input: TurnWorkRouteOptions
): Effect.fn.Return<TranscriptPage, TranscriptQueryFailure | ChatHistoryInvalidCursor> {
  const limit = input.limit ?? 100
  const cursor = input.before ?? input.after
  if (cursor === undefined) {
    return yield* transcript.turnWorkPage({
      _tag: "Latest",
      sessionId: input.sessionId,
      turnId: input.turnId,
      limit
    })
  }
  const sequence = yield* transcript.resolveTurnWorkReference(input.sessionId, input.turnId, cursor)
  if (sequence === null) {
    return yield* new ChatHistoryInvalidCursor({
      sessionId: input.sessionId,
      cursor
    })
  }
  return yield* transcript.turnWorkPage({
    _tag: input.before !== undefined ? "Before" : "After",
    sessionId: input.sessionId,
    turnId: input.turnId,
    limit,
    sequence
  })
})

const snapshotRetry = {
  times: 7,
  schedule: Schedule.exponential("10 millis"),
  while: (error: unknown) => error instanceof HistorySnapshotChanged
}

export const loadStableSnapshot = Effect.fn("ChatHistory.loadStableSnapshot")(
  function* (
    transcript: TranscriptQueries["Service"],
    runs: RunQueries["Service"],
    journal: ChatEventStore["Service"],
    sessionId: string,
    input: HistoryRouteOptions
  ) {
    const before = yield* journal.watermarks(sessionId)
    const run = yield* runs.latestForSession(sessionId)
    const page = yield* loadPage(transcript, sessionId, input)
    const isLatestPage =
      input.before === undefined &&
      input.after === undefined &&
      input.around === undefined &&
      input.aroundSeq === undefined
    const activeTurnId =
      isLatestPage && run !== null && isForegroundRunStatus(run.status) ? run.turnId : null
    const workPage =
      activeTurnId !== null
        ? yield* transcript.turnWorkPage({
            _tag: "Latest",
            sessionId,
            turnId: activeTurnId,
            limit: 100
          })
        : null
    const workResults =
      workPage === null || activeTurnId === null
        ? []
        : yield* transcript.toolResultsFor(
            sessionId,
            [activeTurnId],
            historyToolCallIds(workPage.records),
            "compact"
          )
    const after = yield* journal.watermarks(sessionId)
    if (before.checkpointSequence !== after.checkpointSequence) {
      return yield* new HistorySnapshotChanged({
        before: before.checkpointSequence,
        after: after.checkpointSequence
      })
    }
    return {
      page,
      run,
      work:
        workPage === null || activeTurnId === null
          ? null
          : { turnId: activeTurnId, page: workPage, results: workResults },
      watermark: after
    }
  },
  Effect.retry(snapshotRetry),
  Effect.catchTag(
    "HistorySnapshotChanged",
    (error) =>
      new ChatHistoryError({
        message: "Chat history changed repeatedly while reading its checkpoint",
        cause: error
      })
  )
)
export const loadStableTurnWorkSnapshot = Effect.fn("ChatHistory.loadStableTurnWorkSnapshot")(
  function* (
    transcript: TranscriptQueries["Service"],
    journal: ChatEventStore["Service"],
    input: TurnWorkRouteOptions
  ) {
    const before = yield* journal.watermarks(input.sessionId)
    const page = yield* loadTurnWorkPage(transcript, input)
    const results = yield* transcript.toolResultsFor(
      input.sessionId,
      [input.turnId],
      historyToolCallIds(page.records),
      input.view
    )
    const after = yield* journal.watermarks(input.sessionId)
    if (before.checkpointSequence !== after.checkpointSequence) {
      return yield* new HistorySnapshotChanged({
        before: before.checkpointSequence,
        after: after.checkpointSequence
      })
    }
    return { page, results }
  },
  Effect.retry(snapshotRetry),
  Effect.catchTag(
    "HistorySnapshotChanged",
    (error) =>
      new ChatHistoryError({
        message: "Turn work changed repeatedly while reading its checkpoint",
        cause: error
      })
  )
)
