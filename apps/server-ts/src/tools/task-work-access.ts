import type { TaskRecord } from "../persistence/work/task-record.js"
import type { TaskPatch } from "../persistence/work/task-patch.js"
import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { taskDirectionReview } from "../persistence/work/task-direction.js"
import { TaskDirectionChanged } from "../persistence/work/task-direction.js"
import { Effect } from "effect"
import { SessionQueries, type SessionQueryFailure } from "../persistence/sessions/queries.js"
import { WorkStore, WorkStoreError, type TaskScope } from "../persistence/work/store.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { noSpace } from "./space-tool-access.js"
import { toolFailure } from "./tool-failure.js"
import type { ServerRunContext } from "./run-context.js"
import {
  WORK_OP,
  WORK_REFUSAL_REASON,
  WORK_TARGET,
  WORK_TARGET_DECISION,
  workTarget,
  type WorkBoundaryReason,
  type WorkTarget
} from "./work-reach.js"
import { TASK_STATUS } from "@arden-hq/protocol/spaces/work"
import { STORE_REASON } from "../persistence/errors.js"
import { ACTOR, rootOf } from "../execution/authority.js"
import { refusalError } from "./refusal.js"

const CROSS_SPACE = { refuse: "refuse", handoff: "handoff" } as const

type CrossSpace = (typeof CROSS_SPACE)[keyof typeof CROSS_SPACE]

export const workFailure = (error: WorkStoreError | TaskDirectionChanged): ToolExecutionError => {
  if (error instanceof TaskDirectionChanged) return taskDirectionReview()
  return toolFailure(
    error,
    error.reason === STORE_REASON.conflict ? "Task changed" : "Task update failed"
  )
}

export const updateFailure = (error: WorkStoreError | TaskDirectionChanged): ToolExecutionError =>
  error instanceof WorkStoreError && error.reason === STORE_REASON.conflict
    ? new ToolExecutionError(
        `${error.message}. Read it again with task_get, check what changed, and retry with the updated_at shown there only if your change still applies.`,
        { preview: "Task changed", retryable: true }
      )
    : workFailure(error)

const sessionFailure = (cause: SessionQueryFailure): ToolExecutionError =>
  toolFailure(
    { reason: cause.reason, message: `Could not resolve the current Space: ${cause.message}` },
    "Space unavailable"
  )

export interface TaskToolServices {
  readonly work: WorkStore["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly spaces: SpaceStore["Service"]
}

export const resolveWorkTarget = async (
  services: TaskToolServices,
  { run, signal }: ToolContext<ServerRunContext>,
  requestedSpaceId: string | undefined,
  crossSpace: CrossSpace
): Promise<WorkTarget> => {
  const header = await Effect.runPromise(
    services.sessions.loadHistoryHeader(run.sessionId).pipe(Effect.mapError(sessionFailure)),
    { signal }
  )
  const decision = workTarget({
    authority: run.authority,
    chatSpaceId: header?.spaceId ?? undefined,
    chatSessionId: run.sessionId,
    requestedSpaceId,
    op: crossSpace === CROSS_SPACE.handoff ? WORK_OP.create : WORK_OP.change
  })
  if (decision.kind === WORK_TARGET_DECISION.target) {
    const target = decision.target
    if (target.kind === WORK_TARGET.space && requestedSpaceId !== undefined) {
      const space = await Effect.runPromise(
        services.spaces
          .get(target.spaceId)
          .pipe(Effect.mapError((cause) => toolFailure(cause, "Space unavailable"))),
        { signal }
      )
      if (space === null) throw await noSpace(services, target.spaceId, signal)
    }
    return target
  }
  if (decision.reason === WORK_REFUSAL_REASON.no_space)
    throw await noSpace(services, undefined, signal)
  throw refusalError({
    what: WORK_REFUSAL[decision.reason],
    rule: "boundary",
    instead: decision.instead
  })
}

export const scopeOf = (target: Exclude<WorkTarget, { readonly kind: "job" }>): TaskScope =>
  target.kind === WORK_TARGET.space
    ? { kind: "space", spaceId: target.spaceId }
    : { kind: "chat", sessionId: target.sessionId }

const WORK_REFUSAL: Record<WorkBoundaryReason, string> = {
  outside_job_space:
    "A job (an Automation, a Space's Task or review, and their agents) changes only Work owned by its own Space; it may start a Task on another Space",
  outside_delegated_space: "An agent changes Work only on the Space of the chat that started it",
  unrecorded: "This run's authority was not recorded, so it cannot change Work"
}

const jobPatchFields = new Set([
  "blocked",
  "waiting_on",
  "block_reason",
  "next_attempt_at",
  "completion_result",
  "completion_evidence",
  "completion_note",
  "continuation_context"
])

const WIDE_PATCH_FIELD = { status: "status", body: "body" } as const

type WidePatchField = (typeof WIDE_PATCH_FIELD)[keyof typeof WIDE_PATCH_FIELD]

const isWidePatchField = (field: string): field is WidePatchField =>
  Object.values(WIDE_PATCH_FIELD).some((wide) => wide === field)

export const refuseWidePatch = (patch: TaskPatch, ownTask: boolean): void => {
  const refused = Object.keys(patch).filter((field) => {
    if (!isWidePatchField(field)) return !jobPatchFields.has(field)
    return field === WIDE_PATCH_FIELD.status
      ? patch.status !== TASK_STATUS.done && patch.status !== TASK_STATUS.cancelled
      : !ownTask
  })
  if (refused.length === 0) return
  throw new ToolExecutionError(
    `A run cannot set ${refused.join(", ")} on a Task. It may finish or cancel it (task_finish), ` +
      "wait on something external or book a next check (task_wait), save internal continuation_context, and change its own Task's body. Other fields belong " +
      "to the user — raise it with task_comment instead.",
    { preview: "Field not writable by a run", retryable: false }
  )
}

export const startFailure = (error: WorkStoreError): ToolExecutionError =>
  error.reason === STORE_REASON.conflict
    ? new ToolExecutionError(
        `${error.message}. Change it with task_update, task_wait or task_finish and its key instead of starting it again.`,
        { preview: "Task key already exists", retryable: false }
      )
    : workFailure(error)

export const readTaskAt = async (
  services: TaskToolServices,
  ctx: ToolContext<ServerRunContext>,
  spaceId: string | undefined,
  key: string
): Promise<TaskRecord> => {
  const target = await resolveWorkTarget(services, ctx, spaceId, "refuse")
  return Effect.runPromise(
    (target.kind === WORK_TARGET.job
      ? services.work.getFromJob(target.automationId, key, target.spaceId)
      : services.work.get({ kind: "key", scope: scopeOf(target), key })
    ).pipe(Effect.mapError(workFailure)),
    { signal: ctx.signal }
  )
}

export const fromWorker = (target: WorkTarget, ctx: ToolContext<ServerRunContext>): boolean =>
  target.kind === WORK_TARGET.job || rootOf(ctx.run.authority.actor) === ACTOR.taskWorker
