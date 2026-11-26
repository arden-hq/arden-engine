import { withCurrentSessionActivity } from "./lifecycle-presentation.js"
import { taskWorkItemId } from "./lifecycle-task-work-item.js"
import {
  AutomationFinishedEventSchema,
  AutomationProgressEventSchema,
  ChatInputCommittedEventSchema,
  FocusChoiceChangedEventSchema,
  EntityChangedEventSchema,
  McpServerChangedEventSchema,
  NavigationRequestedEventSchema,
  QuestionChangedEventSchema,
  RecordToldEventSchema,
  TaskProposalChangedEventSchema,
  TaskVisibilityChangedEventSchema,
  WorkChangedEventSchema
} from "@arden-hq/protocol/effect/events"
import {
  appendInTransaction as appendJournalInTransaction,
  JOURNAL_DELIVERY,
  type JournalRecord,
  type JournalRuntime
} from "@arden-hq/journal/effect"
import { DateTime, Effect, Schema, Scope, Stream } from "effect"
import { lifecycleError } from "./lifecycle-archived.js"
import {
  SESSION_LIFECYCLE_STREAM_ID,
  SessionLifecycleEventError,
  SessionLifecycleEvents,
  type LifecycleFeedEvent,
  type OpenSessionLifecycleEvents,
  type SessionLifecycleDelivery,
  type StandaloneFeedEvent
} from "../sessions/events.js"
import {
  ApprovalWaitingEventSchema,
  DecisionRouteChangedEventSchema,
  AutomationChangedEventSchema,
  AutomationQueuedEventSchema,
  CaptureArrivedEventSchema,
  LimitCrossedEventSchema,
  RunSettledEventSchema,
  RunFencedEventSchema,
  TaskHistoryAddedEventSchema
} from "../sessions/internal-events.js"
import type { PersistenceDeps } from "./deps.js"
import { makeSessionPruning } from "./session-history-pruning.js"
import {
  LifecycleRecordSchema,
  journalEvent,
  loadTaskWork,
  makeLifecycleAppends
} from "./lifecycle-appends.js"

const decodeRecord = Effect.fn("SessionLifecycleEvents.decodeRecord")(function* (
  record: JournalRecord
) {
  const event = yield* Schema.decodeUnknownEffect(LifecycleRecordSchema)(record.data).pipe(
    Effect.mapError((cause) => lifecycleError("follow", "Stored global event is corrupt", cause))
  )
  if (event.type !== record.type) {
    return yield* lifecycleError("follow", "Stored global event type does not match its payload")
  }
  return event
})

interface FeedEventMessages {
  readonly invalid: string
  readonly failed: string
}

type FeedEventSpecs = {
  readonly [Type in LifecycleFeedEvent["type"]]: FeedEventMessages & {
    readonly schema: Schema.Decoder<Extract<LifecycleFeedEvent, { readonly type: Type }>>
    readonly live?: true
  }
}

const automationMessages: FeedEventMessages = {
  invalid: "Invalid Automation event",
  failed: "Could not append the Automation event"
}
const taskAuthorityMessages: FeedEventMessages = {
  invalid: "Invalid Task authority event",
  failed: "Could not append the Task authority event"
}
const workMessages: FeedEventMessages = {
  invalid: "Invalid Work event",
  failed: "Could not append the Work event"
}

const runMessages: FeedEventMessages = {
  invalid: "Invalid run event",
  failed: "Could not append the run event"
}

const feedEventSpecs: FeedEventSpecs = {
  automation_progress: {
    schema: AutomationProgressEventSchema,
    ...automationMessages,
    live: true
  },
  automation_finished: { schema: AutomationFinishedEventSchema, ...automationMessages },
  record_told: { schema: RecordToldEventSchema, ...automationMessages },
  task_proposal_changed: { schema: TaskProposalChangedEventSchema, ...taskAuthorityMessages },
  focus_choice_changed: { schema: FocusChoiceChangedEventSchema, ...taskAuthorityMessages },
  work_changed: { schema: WorkChangedEventSchema, ...workMessages },
  question_changed: { schema: QuestionChangedEventSchema, ...workMessages },
  task_visibility_changed: { schema: TaskVisibilityChangedEventSchema, ...workMessages },
  chat_input_committed: {
    schema: ChatInputCommittedEventSchema,
    invalid: "Invalid personal Chat input",
    failed: "Could not append personal Chat input"
  },
  navigation_requested: {
    schema: NavigationRequestedEventSchema,
    invalid: "Invalid navigation request",
    failed: "Could not append the navigation request"
  },
  mcp_server_changed: {
    schema: McpServerChangedEventSchema,
    invalid: "Invalid connection change",
    failed: "Could not append the connection change"
  },
  entity_changed: {
    schema: EntityChangedEventSchema,
    invalid: "Invalid change",
    failed: "Could not append the change"
  },
  run_settled: { schema: RunSettledEventSchema, ...runMessages },
  run_fenced: { schema: RunFencedEventSchema, ...runMessages },
  approval_waiting: {
    schema: ApprovalWaitingEventSchema,
    invalid: "Invalid waiting approval",
    failed: "Could not append the waiting approval"
  },
  decision_route_changed: {
    schema: DecisionRouteChangedEventSchema,
    invalid: "Invalid decision route change",
    failed: "Could not append the decision route change"
  },
  automation_queued: {
    schema: AutomationQueuedEventSchema,
    invalid: "Invalid queued Automation work",
    failed: "Could not append the queued Automation work"
  },
  automation_changed: {
    schema: AutomationChangedEventSchema,
    invalid: "Invalid Automation change",
    failed: "Could not append the Automation change"
  },
  task_history_added: {
    schema: TaskHistoryAddedEventSchema,
    invalid: "Invalid Task history row",
    failed: "Could not append the Task history row"
  },
  capture_arrived: {
    schema: CaptureArrivedEventSchema,
    invalid: "Invalid capture",
    failed: "Could not append the capture"
  },
  limit_crossed: {
    schema: LimitCrossedEventSchema,
    invalid: "Invalid plan limit crossing",
    failed: "Could not append the plan limit crossing"
  }
}

export const makeSessionLifecycleEvents = ({
  writer,
  journal,
  chatEvents
}: Pick<PersistenceDeps, "writer" | "chatEvents"> & {
  readonly journal: JournalRuntime
}): SessionLifecycleEvents["Service"] => {
  const sql = writer.sql
  const { afterCommit, appendInTransaction, appendBlockingWorkInTransaction } =
    makeLifecycleAppends({ sql, journal })
  const decodeEvent = Effect.fn("SessionLifecycleEvents.decodeEvent")(function* (
    event: LifecycleFeedEvent
  ): Effect.fn.Return<LifecycleFeedEvent, SessionLifecycleEventError> {
    const spec = feedEventSpecs[event.type]
    return yield* Schema.decodeUnknownEffect(spec.schema)(event).pipe(
      Effect.mapError((cause) => lifecycleError("append", spec.invalid, cause))
    )
  })

  const appendValidEventInTransaction = Effect.fn(
    "SessionLifecycleEvents.appendValidEventInTransaction"
  )(function* (valid: LifecycleFeedEvent) {
    const feedEvent = yield* journalEvent(valid, feedEventSpecs[valid.type])
    const itemId = taskWorkItemId(valid)
    const taskWork =
      itemId === null ? undefined : yield* loadTaskWork(sql, { kind: "item", id: itemId })
    return yield* appendJournalInTransaction(
      sql,
      SESSION_LIFECYCLE_STREAM_ID,
      taskWork === undefined ? [feedEvent] : [feedEvent, yield* journalEvent(taskWork)]
    ).pipe(
      Effect.mapError((cause) =>
        lifecycleError("append", feedEventSpecs[valid.type].failed, cause)
      ),
      Effect.tap(afterCommit)
    )
  })

  const appendEventInTransaction = Effect.fn("SessionLifecycleEvents.appendEventInTransaction")(
    function* (event: LifecycleFeedEvent) {
      return yield* appendValidEventInTransaction(yield* decodeEvent(event))
    }
  )

  const appendEvent = Effect.fn("SessionLifecycleEvents.appendEvent")(function* (
    event: StandaloneFeedEvent
  ) {
    const valid = yield* decodeEvent(event)
    return yield* writer
      .transact(appendValidEventInTransaction(valid))
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionLifecycleEventError
            ? cause
            : lifecycleError("append", feedEventSpecs[event.type].failed, cause)
        )
      )
  })

  const { pruneSessionHistory, pruneSupersededSnapshots } = makeSessionPruning(writer)
  const open = Effect.fn("SessionLifecycleEvents.open")(function* (
    afterSequence?: number
  ): Effect.fn.Return<OpenSessionLifecycleEvents, SessionLifecycleEventError, Scope.Scope> {
    const opened = yield* journal
      .openFollow({
        streamId: SESSION_LIFECYCLE_STREAM_ID,
        ...(afterSequence === undefined ? { startAt: "latest" as const } : { afterSequence })
      })
      .pipe(
        Effect.mapError((cause) =>
          lifecycleError("follow", "Could not open the Session lifecycle stream", cause)
        )
      )
    const stream = opened.stream.pipe(
      Stream.mapEffect(
        (delivery): Effect.Effect<SessionLifecycleDelivery, SessionLifecycleEventError> => {
          if (delivery.kind === JOURNAL_DELIVERY.overflow) {
            return Effect.fail(
              lifecycleError("follow", "Session lifecycle follower buffer overflowed")
            )
          }
          return delivery.kind === JOURNAL_DELIVERY.reset
            ? Effect.succeed({ kind: "reset", reason: delivery.reason, cursor: delivery.cursor })
            : decodeRecord(delivery.record).pipe(
                Effect.map((event): SessionLifecycleDelivery => ({
                  kind: "record",
                  sequence: delivery.record.sequence,
                  createdAtMs: DateTime.toEpochMillis(
                    DateTime.makeUnsafe(delivery.record.createdAt)
                  ),
                  event: withCurrentSessionActivity({
                    event,
                    currentActivity: chatEvents.currentActivity
                  }),
                  replayed: delivery.replayed
                }))
              )
        }
      ),
      Stream.mapError((cause) =>
        cause instanceof SessionLifecycleEventError
          ? cause
          : lifecycleError("follow", "Could not follow Session lifecycle events", cause)
      )
    )
    return { initialSequence: opened.initialSequence, stream }
  })

  return SessionLifecycleEvents.of({
    appendInTransaction,
    appendBlockingWorkInTransaction,
    appendEventInTransaction,
    appendEvent,
    pruneSessionHistory,
    pruneSupersededSnapshots,
    open
  })
}
