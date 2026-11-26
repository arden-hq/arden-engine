import { TaskRecordSchema } from "../work/task-record.js"
import { type TaskRecord } from "../work/task-record.js"
import { captureMutationVersions } from "./mutation-links.js"
import { readRecordedHistory } from "./recorded-history.js"
import { freshRow } from "./automation-enqueue.js"
import { makeWorkExecution } from "./work-execution.js"
import { makeWorkEvents } from "./work-events.js"
import { assertRunTaskAuthority } from "./run-task-authority.js"
import { assertCallPlan } from "./task-direction.js"
import { TaskDirectionChanged } from "../work/task-direction.js"
import { verifyTaskCompletion } from "./work-completion.js"
import { makeFinishCheck } from "./task-plan.js"
import { readWorkState } from "./work-activity.js"
import {
  isTaskUnfinished,
  SPACE_TASK_CREATED_BY,
  SPACE_TASK_EVENT_TYPE,
  SPACE_TASK_RUNS_IN,
  TASK_STATUS,
  type SpaceTaskActor
} from "@arden-hq/protocol/spaces/work"
import { STORE_REASON } from "../errors.js"
import { RecordedHistoryError } from "../history.js"
import {
  decodeTaskUpdateRequestEffect,
  decodeUpdateSpaceTaskPatchEffect,
  type TaskPatch
} from "../work/task-patch.js"
import { DateTime, Effect, Schema } from "effect"
import { taskJobId } from "../space-job-id.js"
import { renameOwnedJob } from "./job-labels.js"
import { WorkStore, WorkStoreError, type TaskAddress } from "../work/store.js"
import { REVIEWED_TASK_FIELDS } from "../automations/space-review.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { taskWaker } from "./space-job-types.js"
import {
  decodeWorkItem as decodeWorkItemWithSources,
  workItemColumns,
  type WorkItemRow
} from "./work-items.js"
import { readTask, resolveTaskItem, taskSpaceActiveSql } from "./task-address.js"
import {
  ensureTaskBudget,
  liftsBudgetStop,
  makeInChatTaskStore,
  requireInChatHome,
  stopSpentTasks
} from "./in-chat-task.js"
import { spentBudgetStop } from "./task-block.js"
import { makeWorkCaptureSql } from "./work-capture.js"
import { readInferenceReview } from "./work-inference.js"
import { makeWorkPage } from "./work-page.js"
import { makeWorkAttempts } from "./work-attempts.js"
import { makeWorkQuestionSql } from "./work-questions.js"
import { makeTaskContractSql } from "./task-contract.js"
import { makeWorkDeliverySql } from "./work-deliveries.js"
import { workError } from "./work-records.js"
import { makeWorkSourceSql } from "./work-sources.js"
import { makeWorkAttachments } from "./work-attachments.js"
import { makeWorkVisibility } from "./work-visibility.js"
import type { PersistenceDeps } from "./deps.js"
import { stampTaskState, taskStateWrite } from "../work/task-state.js"
import { makeWorkJobTarget } from "./work-job-target.js"
import { makeTaskContextReads } from "./task-context-reads.js"
import { makeTaskComments } from "./task-comments.js"
import { makeTaskBlockLoop } from "./task-block-loop.js"
import {
  onlyScheduleChanged,
  normalizeBlockState,
  taskChanged,
  taskChangeWords
} from "./task-update-fields.js"

const utcInstant = (value: string | null): string | null =>
  value === null ? null : new Date(value).toISOString()

export const makeWorkStore = ({
  writer,
  sessionEvents,
  reader,
  diagnostics
}: Pick<
  PersistenceDeps,
  "writer" | "sessionEvents" | "reader" | "diagnostics"
>): WorkStore["Service"] => {
  const sql = writer.sql
  const page = makeWorkPage({ writer, reader })
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
  const sources = makeWorkSourceSql(sql)
  const decodeWorkItem = (row: WorkItemRow) =>
    sources
      .read([row.item_id])
      .pipe(
        Effect.flatMap((byItem) =>
          readWorkState(sql, [row.item_id]).pipe(
            Effect.flatMap((activity) =>
              decodeWorkItemWithSources(
                row,
                byItem.get(row.item_id) ?? [],
                activity.get(row.item_id)
              )
            )
          )
        )
      )

  const { taskEvent } = makeWorkEvents(sql, sessionEvents)

  const blocks = makeTaskBlockLoop({ sql, taskEvent, spaceJobs })

  const { create, createFromChat, createInChat } = makeWorkCaptureSql({
    writer,
    sessionEvents,
    taskEvent
  })
  const inferenceReview: WorkStore["Service"]["inferenceReview"] = (spaceId) =>
    readInferenceReview({ sql: reader, consistent: writer.snapshot }, spaceId)

  const updateFor = Effect.fn("SqliteWorkStore.updateFor")(function* (
    address: TaskAddress,
    expectedUpdatedAt: string,
    patch: TaskPatch,
    actor: SpaceTaskActor,
    runId?: string,
    fromJob = false,
    toolCallId?: string
  ): Effect.fn.Return<TaskRecord, WorkStoreError | TaskDirectionChanged> {
    const validPatch = yield* decodeUpdateSpaceTaskPatchEffect(patch).pipe(
      Effect.mapError((cause) => workError("invalid", "Invalid Space task update", cause))
    )
    const validRequest = yield* decodeTaskUpdateRequestEffect(expectedUpdatedAt, validPatch).pipe(
      Effect.mapError((cause) =>
        workError("invalid", "Expected work task timestamp is invalid", cause)
      )
    )
    const expectedTimestamp = validRequest.expected_updated_at
    const byWorker = actor === SPACE_TASK_CREATED_BY.worker

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const itemId = yield* resolveTaskItem(sql, address)
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "task",
            id: itemId,
            identity:
              runId !== undefined && toolCallId !== undefined ? { runId, toolCallId } : undefined
          })
          const rows = yield* sql<WorkItemRow & { readonly continuation_context: string | null }>`
        SELECT continuation_context, ${workItemColumns(sql)}
        FROM space_tasks
        WHERE item_id = ${itemId}
        LIMIT 1
      `.pipe(
            Effect.mapError((cause) =>
              workError("storage", "Could not load Space task for update", cause)
            )
          )
          const row = rows[0]
          if (row === undefined) {
            return yield* workError("not_found", "Space task not found")
          }

          const attemptOf = runId
            ? yield* assertRunTaskAuthority(sql, runId, row.item_id)
            : undefined
          if (runId && toolCallId) yield* assertCallPlan(sql, { runId, toolCallId })
          const ownAttempt = runId ? attemptOf !== undefined : byWorker
          const { continuation_context: currentContext, ...publicRow } = row
          const current = yield* decodeWorkItem(publicRow)
          const currentAt = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
            current.updated_at
          ).pipe(
            Effect.mapError((cause) =>
              workError("storage", "Stored Space task timestamp is corrupt", cause)
            )
          )
          if (current.updated_at !== expectedTimestamp) {
            return yield* workError("conflict", "Work task changed since it was loaded")
          }

          if (fromJob && validPatch.body !== undefined && attemptOf !== row.item_id)
            return yield* workError("conflict", "A run may change the body only of its own Task")
          if (byWorker && validPatch.token_budget !== undefined)
            return yield* workError("invalid", "Only you change a Task's token budget")
          const resumed =
            validPatch.token_budget !== undefined &&
            !Object.hasOwn(validPatch, "blocked") &&
            !Object.hasOwn(validPatch, "waiting_on") &&
            liftsBudgetStop(yield* spentBudgetStop(sql, row.item_id), validPatch.token_budget)
          const blockState = resumed
            ? { blocked: false, waiting_on: null }
            : yield* normalizeBlockState(current, validPatch)
          const status = validPatch.status ?? current.status
          const statusChanged = status !== current.status
          if (validPatch.completion_result !== undefined && !statusChanged) {
            return yield* workError("invalid", "A completion result requires a new Done transition")
          }
          if (
            byWorker &&
            statusChanged &&
            status === TASK_STATUS.done &&
            !validPatch.completion_result
          ) {
            return yield* workError(
              "invalid",
              "Worker completion must include completion_result in the same update"
            )
          }
          const completionResult =
            byWorker && statusChanged && status === TASK_STATUS.done
              ? yield* verifyTaskCompletion({ sql, itemId: row.item_id, runId, patch: validPatch })
              : validPatch.completion_result
          const {
            completion_result: _result,
            completion_evidence: _evidence,
            completion_note: _note,
            continuation_context: _context,
            ...taskPatch
          } = validPatch
          const candidate = {
            ...current,
            ...taskPatch,
            ...blockState,
            status,
            completed_at: current.completed_at,
            updated_at: current.updated_at
          }
          const live = isTaskUnfinished(candidate.status)
          if (
            candidate.runs_in === SPACE_TASK_RUNS_IN.chat &&
            live &&
            (current.runs_in !== SPACE_TASK_RUNS_IN.chat || current.status !== candidate.status)
          ) {
            if (current.home_session_id === null)
              return yield* workError(
                "invalid",
                "This Task belongs to no chat. Ask for it in a chat to move it there"
              )
            yield* requireInChatHome(sql, {
              sessionId: current.home_session_id,
              itemId: row.item_id
            })
          }
          const publicChanged = taskChanged(current, candidate)
          const statePatch = validPatch.continuation_context
          const stateSections =
            statePatch === undefined || statePatch === null
              ? undefined
              : yield* taskStateWrite(currentContext, statePatch, runId)
          const stateWritten =
            statePatch === null ? currentContext !== null : stateSections !== undefined
          if (!publicChanged && !stateWritten) {
            return current
          }

          const now = yield* DateTime.now
          const updatedAtValue =
            DateTime.toEpochMillis(now) > DateTime.toEpochMillis(currentAt)
              ? now
              : DateTime.add(currentAt, { milliseconds: 1 })
          const updatedAt = DateTime.formatIso(updatedAtValue)
          let context = currentContext
          if (statePatch === null) context = null
          else if (stateSections !== undefined)
            context = stampTaskState(stateSections, { at: updatedAt, runId })
          const finished = !isTaskUnfinished(status)
          let completedAt = current.completed_at
          if (statusChanged) completedAt = finished ? updatedAt : null

          const blockReason =
            blockState.blocked && (!current.blocked || blockState.waiting_on !== current.waiting_on)
              ? blockState.waiting_on
              : null
          const stopped = blockReason !== null && (yield* blocks.strike(row.item_id, blockReason))
          if (statusChanged && status === TASK_STATUS.done) yield* blocks.forget(row.item_id)

          const next = yield* Schema.decodeUnknownEffect(TaskRecordSchema)({
            ...candidate,
            completed_at: completedAt,
            updated_at: updatedAt,
            next_attempt_at: stopped ? null : candidate.next_attempt_at
          }).pipe(
            Effect.mapError((cause) => workError("invalid", "Invalid Space task update", cause))
          )

          const updatedRows = yield* sql<WorkItemRow>`
        UPDATE space_tasks
        SET continuation_context = ${context},
            text = ${next.text},
            body = ${next.body},
            status = ${next.status},
            owner = ${next.owner},
            runs_in = ${next.runs_in},
            token_budget = ${next.token_budget},
            blocked = ${next.blocked ? 1 : 0},
            waiting_on = ${next.waiting_on},
            due_at = ${next.due_at},
            next_attempt_at = ${utcInstant(next.next_attempt_at)},
            updated_at = ${next.updated_at},
            completed_at = ${next.completed_at}
        WHERE item_id = ${itemId}
          AND updated_at = ${expectedTimestamp}
          AND ${taskSpaceActiveSql(sql)}
        RETURNING ${workItemColumns(sql)}
      `.pipe(Effect.mapError((cause) => workError("storage", "Could not update Space task", cause)))
          const updatedRow = updatedRows[0]
          if (updatedRow === undefined) {
            return yield* workError("conflict", "Work task changed since it was loaded")
          }
          if (
            current.token_budget !== next.token_budget ||
            (next.runs_in === SPACE_TASK_RUNS_IN.chat &&
              current.runs_in !== SPACE_TASK_RUNS_IN.chat)
          )
            yield* ensureTaskBudget(sql, updatedRow.item_id, next.token_budget)
          const spent = yield* stopSpentTasks(
            { sql, sessionEvents },
            { itemId: updatedRow.item_id },
            updatedAt
          )

          const changeType =
            blockReason === null ? SPACE_TASK_EVENT_TYPE.updated : SPACE_TASK_EVENT_TYPE.blocked
          const outcome = statusChanged && !isTaskUnfinished(next.status) ? next.status : changeType
          const eventType = onlyScheduleChanged(current, next)
            ? SPACE_TASK_EVENT_TYPE.scheduled
            : outcome
          if (publicChanged)
            yield* taskEvent(
              updatedRow.space_id,
              updatedRow.item_id,
              eventType,
              completionResult ??
                (next.blocked && validPatch.block_reason !== undefined
                  ? validPatch.block_reason
                  : undefined) ??
                taskChangeWords(current, next),
              updatedAt,
              runId,
              completionResult === undefined ? "summary" : "result",
              validPatch.completion_result
            )
          if (stopped)
            yield* blocks.breakLoop(updatedRow.space_id, updatedRow.item_id, blockReason, updatedAt)
          if (current.text !== next.text)
            yield* renameOwnedJob(sql, taskJobId(updatedRow.item_id), next.text)

          if (status !== TASK_STATUS.open) {
            const settling = byWorker && statusChanged && finished ? runId : undefined
            yield* spaceJobs.stopTask(updatedRow.item_id, settling)
          } else if (
            !ownAttempt ||
            (current.runs_in === SPACE_TASK_RUNS_IN.chat &&
              next.runs_in === SPACE_TASK_RUNS_IN.background)
          ) {
            const rescheduled = current.next_attempt_at !== next.next_attempt_at
            if (rescheduled && next.next_attempt_at !== null && next.next_attempt_at > updatedAt)
              yield* sql`DELETE FROM automation_event_queue
                WHERE task_id = ${taskJobId(updatedRow.item_id)} AND ${freshRow(sql)}`.pipe(
                Effect.mapError((cause) =>
                  workError("storage", "Could not replace the Task's waiting wake", cause)
                )
              )
            yield* spaceJobs.queueTaskWake(
              updatedRow.item_id,
              updatedAt,
              taskWaker(runId),
              !ownAttempt && !rescheduled
            )
          }

          if (
            runId === undefined &&
            actor === SPACE_TASK_CREATED_BY.user &&
            REVIEWED_TASK_FIELDS.some((field) => row[field] !== updatedRow[field])
          )
            yield* spaceJobs.queueTaskChangedByHand(updatedRow.item_id, updatedAt)
          yield* recordVersions
          if (spent.length === 0) return yield* decodeWorkItem(updatedRow)
          const stoppedRows = yield* sql<WorkItemRow>`
            SELECT ${workItemColumns(sql)} FROM space_tasks WHERE item_id = ${updatedRow.item_id}
          `.pipe(
            Effect.mapError((cause) => workError("storage", "Could not reload the Task", cause))
          )
          return yield* decodeWorkItem(stoppedRows[0] ?? updatedRow)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkStoreError || cause instanceof TaskDirectionChanged
            ? cause
            : workError("storage", "Could not complete Space task update", cause)
        )
      )
  })

  const update: WorkStore["Service"]["update"] = (
    address,
    expectedUpdatedAt,
    patch,
    runId,
    toolCallId,
    actor
  ) =>
    updateFor(
      address,
      expectedUpdatedAt,
      patch,
      actor ?? (runId ? SPACE_TASK_CREATED_BY.worker : SPACE_TASK_CREATED_BY.user),
      runId,
      false,
      toolCallId
    )

  const stop: WorkStore["Service"]["stop"] = Effect.fn("SqliteWorkStore.stop")(
    function* (address, expectedUpdatedAt) {
      const task = yield* updateFor(
        address,
        expectedUpdatedAt,
        { status: TASK_STATUS.cancelled },
        SPACE_TASK_CREATED_BY.user
      ).pipe(
        Effect.catchTag("TaskDirectionChanged", (error) => Effect.die(error)),
        Effect.catchTag("WorkStoreError", (error) => {
          if (error.reason !== STORE_REASON.conflict) return Effect.fail(error)
          return resolveTaskItem(sql, address).pipe(
            Effect.flatMap(
              (itemId) => sql<WorkItemRow>`
        SELECT ${workItemColumns(sql)}
        FROM space_tasks
        WHERE item_id = ${itemId} AND status = 'cancelled'
        LIMIT 1
      `
            ),
            Effect.mapError((cause) =>
              cause instanceof WorkStoreError
                ? cause
                : workError("storage", "Could not reload an already stopped Task", cause)
            ),
            Effect.flatMap((rows) =>
              rows[0] === undefined ? Effect.fail(error) : decodeWorkItem(rows[0])
            )
          )
        })
      )
      return task
    }
  )

  const jobTarget = makeWorkJobTarget(sql)

  const updateFromJob = Effect.fn("SqliteWorkStore.updateFromJob")(function* (
    originAutomationId: string,
    key: string,
    expectedUpdatedAt: string,
    patch: TaskPatch,
    requestedSpaceId?: string,
    runId?: string,
    toolCallId?: string
  ): Effect.fn.Return<TaskRecord, WorkStoreError | TaskDirectionChanged> {
    const target = yield* jobTarget(originAutomationId, key, requestedSpaceId)
    return yield* updateFor(
      target,
      expectedUpdatedAt,
      patch,
      SPACE_TASK_CREATED_BY.worker,
      runId,
      true,
      toolCallId
    )
  })

  const comments = makeTaskComments({ writer, jobTarget })

  const get: WorkStore["Service"]["get"] = (address) => readTask(sql, page, address)

  return WorkStore.of({
    history: (input) =>
      writer
        .snapshot(readRecordedHistory(reader, "task", input))
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof WorkStoreError
              ? cause
              : workError(
                  cause instanceof RecordedHistoryError ? cause.reason : "storage",
                  "Could not read Task history",
                  cause
                )
          )
        ),
    ...makeTaskContextReads({ writer }),
    execution: makeWorkExecution(sql),
    ...makeWorkVisibility({ writer }),
    attempts: makeWorkAttempts(sql),
    ...makeWorkDeliverySql({ writer, sessionEvents, diagnostics }),
    ...makeWorkQuestionSql({ writer, sessionEvents }),
    ...makeTaskContractSql({ writer }),
    page,
    create,
    createFromChat,
    createInChat,
    get,
    getFromJob: (originAutomationId, key, requestedSpaceId) =>
      jobTarget(originAutomationId, key, requestedSpaceId).pipe(Effect.flatMap(get)),
    update,
    ...makeInChatTaskStore({ writer, sessionEvents }),
    stop,
    comment: comments.comment,
    inferenceReview,
    finishCheck: makeFinishCheck(sql),
    updateFromJob,
    commentFromJob: comments.commentFromJob,
    ...makeWorkAttachments({ writer })
  })
}
