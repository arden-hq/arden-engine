import type { SpaceReviewSnapshot } from "../automations/job-prompt.js"
import { Effect } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { AutomationTriggerContext } from "@arden-hq/protocol/automations"
import type { SessionLifecycleEventError } from "../sessions/events.js"
import type { UnitOfWork } from "../unit-of-work.js"
import type { JsonColumnError } from "./json.js"

import { type SpaceJobRecoveryCursor } from "./space-job-recovery.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { wakeCause } from "../automations/event-cause.js"

export type EventWake = Extract<AutomationTriggerContext, { readonly source: "event" }>

export type WakeCause = Pick<EventWake, "produced_by" | "chain_depth">

export const woken: (producedBy: string | null, chainDepth: number) => WakeCause = wakeCause

export const NO_RUN = woken(null, 0)

export const TASK_WAKER = { run: "run", owner: "owner", continuation: "continuation" } as const

export type TaskWaker =
  | { readonly kind: typeof TASK_WAKER.run; readonly runId: string }
  | { readonly kind: typeof TASK_WAKER.owner }
  | { readonly kind: typeof TASK_WAKER.continuation }

export const taskWaker = (runId: string | undefined): TaskWaker =>
  runId === undefined ? { kind: TASK_WAKER.owner } : { kind: TASK_WAKER.run, runId }

export interface JobState {
  readonly automationId: string
  readonly enabled: boolean
  readonly purpose: "space_review" | "task_execution"
}

export type ReviewJob = { readonly key: string; readonly spaceId: string }

type SpaceJobWrite<A> = Effect.Effect<
  A,
  SqlError | JsonColumnError | SessionLifecycleEventError,
  UnitOfWork
>

export interface SpaceJobSql {
  readonly reconcile: (
    now: string,
    cursor: SpaceJobRecoveryCursor | undefined
  ) => SpaceJobWrite<SpaceJobRecoveryCursor | undefined>
  readonly materializeDue: (now: string) => SpaceJobWrite<void>
  readonly syncSpace: (spaceId: string, now: string) => SpaceJobWrite<JobState | null>
  readonly queueOwnerSpaceChangeWake: (
    spaceId: string,
    now: string,
    runId: string | undefined
  ) => SpaceJobWrite<void>
  readonly queueTaskChangedByHand: (itemId: string, now: string) => SpaceJobWrite<boolean>
  readonly retryReview: (review: ReviewJob, now: string) => SpaceJobWrite<void>
  readonly queueInferenceChat: (sessionId: string, now: string) => SpaceJobWrite<boolean>
  readonly linkChat: (
    spaceId: string,
    sessionId: string,
    throughSequence: number,
    now: string
  ) => SpaceJobWrite<boolean>
  readonly unlinkedSpaces: (
    sessionId: string,
    throughSequence: number,
    spaceIds: ReadonlyArray<string>
  ) => SpaceJobWrite<ReadonlyArray<string>>
  readonly queueTaskWake: (
    itemId: string,
    now: string,
    by: TaskWaker,
    fromPerson?: boolean
  ) => SpaceJobWrite<void>
  readonly stopTask: (itemId: string, settlingRunId?: string) => SpaceJobWrite<void>
  readonly spaceReviewContext: (
    spaceId: string
  ) => Effect.Effect<SpaceReviewSnapshot | undefined, SqlError>
  readonly keepMoving: (itemId: string, chatRunId: string, now: string) => SpaceJobWrite<void>
  readonly failTask: (
    itemId: string,
    error: string | null,
    now: string,
    chatRunId: string | null
  ) => SpaceJobWrite<void>
}

export const internalRef = (automationId: string): string => {
  const digest = sha256Hex(automationId).slice(0, 12)
  return `internal-job~${digest}`
}
