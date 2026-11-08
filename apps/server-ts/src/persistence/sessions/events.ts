import type {
  AutomationEvent,
  AutomationFinishedEvent,
  AutomationProgressEvent,
  ChatInputCommittedEvent,
  EntityChangedEvent,
  FocusChoiceChangedEvent,
  McpServerChangedEvent,
  NavigationRequestedEvent,
  QuestionChangedEvent,
  RecordToldEvent,
  TaskProposalChangedEvent,
  TaskVisibilityChangedEvent,
  WorkChangedEvent
} from "@arden-hq/protocol"
import type { JournalAppendResult } from "@arden-hq/journal/effect"
import { Context, Effect, Schema, Scope, Stream } from "effect"
import type { UnitOfWork } from "../unit-of-work.js"
import type { InternalLifecycleEvent } from "./internal-events.js"

export const SESSION_LIFECYCLE_STREAM_ID = "automation:events"

export type SessionLifecycleEventType = "session_created" | "session_activity"
type DurableAutomationEvent = AutomationProgressEvent | AutomationFinishedEvent | RecordToldEvent
type TaskAuthorityChangedEvent = TaskProposalChangedEvent | FocusChoiceChangedEvent
type WorkLifecycleEvent = WorkChangedEvent | QuestionChangedEvent | TaskVisibilityChangedEvent
export type LifecycleFeedEvent =
  | DurableAutomationEvent
  | TaskAuthorityChangedEvent
  | WorkLifecycleEvent
  | EntityChangedEvent
  | ChatInputCommittedEvent
  | StandaloneFeedEvent
  | InternalLifecycleEvent

export type StandaloneFeedEvent = NavigationRequestedEvent | McpServerChangedEvent

export class SessionLifecycleEventError extends Schema.TaggedError<SessionLifecycleEventError>()(
  "SessionLifecycleEventError",
  {
    reason: Schema.tag("storage"),
    operation: Schema.Literals(["append", "follow", "prune"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export type SessionLifecycleDelivery =
  | {
      readonly kind: "record"
      readonly sequence: number
      readonly createdAtMs: number
      readonly event: AutomationEvent | InternalLifecycleEvent
      readonly replayed: boolean
    }
  | {
      readonly kind: "reset"
      readonly reason: "future_cursor" | "replay_gap"
      readonly cursor: number
    }

export interface OpenSessionLifecycleEvents {
  readonly initialSequence: number
  readonly stream: Stream.Stream<SessionLifecycleDelivery, SessionLifecycleEventError>
}

export class SessionLifecycleEvents extends Context.Service<
  SessionLifecycleEvents,
  {
    readonly appendInTransaction: (
      type: SessionLifecycleEventType,
      sessionId: string
    ) => Effect.Effect<JournalAppendResult, SessionLifecycleEventError, UnitOfWork>
    readonly appendBlockingWorkInTransaction: (
      sessionId: string
    ) => Effect.Effect<JournalAppendResult, SessionLifecycleEventError, UnitOfWork>
    readonly appendEventInTransaction: (
      event: LifecycleFeedEvent
    ) => Effect.Effect<JournalAppendResult, SessionLifecycleEventError, UnitOfWork>
    readonly appendEvent: (
      event: StandaloneFeedEvent
    ) => Effect.Effect<JournalAppendResult, SessionLifecycleEventError>
    readonly pruneSessionHistory: (
      entries: ReadonlyArray<{ readonly sessionId: string; readonly retainedSequence: number }>
    ) => Effect.Effect<number, SessionLifecycleEventError>
    readonly pruneSupersededSnapshots: () => Effect.Effect<number, SessionLifecycleEventError>
    readonly open: (
      afterSequence?: number
    ) => Effect.Effect<OpenSessionLifecycleEvents, SessionLifecycleEventError, Scope.Scope>
  }
>()("@arden-hq/server/persistence/sessions/SessionLifecycleEvents") {}
