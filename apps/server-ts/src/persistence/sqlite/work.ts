import { countOf } from "@arden-hq/std/count"
import { captureMutationVersions } from "./mutation-links.js"
import { readRecordedHistory } from "./recorded-history.js"
import { freshRow } from "./automation-enqueue.js"
import { readRunTaskContext, readTaskWorkerContext } from "./space-job-context.js"
import { makeWorkExecution } from "./work-execution.js"
import { makeWorkEvents } from "./work-events.js"
import { assertRunTaskAuthority } from "./run-task-authority.js"
import { verifyTaskCompletion } from "./work-completion.js"
import { makeFinishCheck, readTaskIntent } from "./task-plan.js"
import { readWorkState } from "./work-activity.js"
import {
  isTaskUnfinished,
  type CreateSpaceTaskCommentInput,
  type SpaceTask,
  type SpaceTaskComment,
  type UpdateSpaceTaskPatch
} from "@arden-hq/protocol/spaces/work"
import {
  SpaceTaskSchema,
  InternalUpdateSpaceTaskRequestSchema,
  decodeCreateSpaceTaskCommentInputEffect,
  decodeUpdateSpaceTaskPatchEffect
} from "@arden-hq/protocol/effect/spaces/work"
import { DateTime, Effect, Schema } from "effect"
import { taskJobId } from "../space-job-id.js"
import { renameOwnedJob } from "./job-labels.js"
import { WorkStore, WorkStoreError, type TaskAddress } from "../work/store.js"
import { spaceChoices } from "../spaces/store.js"
import { makeSpaceJobSql } from "./space-jobs.js"
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
import { recordTell } from "./run-tell.js"
import { makeWorkDeliverySql } from "./work-deliveries.js"
import { decodeWorkComment, workError, type WorkCommentRow } from "./work-records.js"
import { makeWorkSourceSql } from "./work-sources.js"
import { makeWorkAttachments } from "./work-attachments.js"
import { makeWorkVisibility } from "./work-visibility.js"
import type { PersistenceDeps } from "./deps.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { stampTaskState, taskStateWrite } from "../work/task-state.js"
import { userAutomationSql } from "./authority-sql.js"

const utcInstant = (value: string | null): string | null =>
  value === null ? null : new Date(value).toISOString()

const summarizedTaskFields = [
  "text",
  "body",
  "status",
  "owner",
  "runs_in",
  "token_budget",
  "blocked",
  "waiting_on",
  "due_at",
  "next_attempt_at"
] as const

const mutableTaskFields = [...summarizedTaskFields, "completed_at"] as const

const normalizeBlockState = (
  current: Pick<SpaceTask, "blocked" | "waiting_on">,
  patch: UpdateSpaceTaskPatch
): Effect.Effect<Pick<SpaceTask, "blocked" | "waiting_on">, WorkStoreError> => {
  if (!Object.hasOwn(patch, "blocked") && !Object.hasOwn(patch, "waiting_on")) {
    return Effect.succeed({ blocked: current.blocked, waiting_on: current.waiting_on })
  }

  const blocked = patch.blocked ?? current.blocked
  if (!blocked) {
    if (
      Object.hasOwn(patch, "waiting_on") &&
      patch.waiting_on !== undefined &&
      patch.waiting_on !== null
    ) {
      return Effect.fail(workError("invalid", "waiting_on is only meaningful on a blocked task"))
    }
    return Effect.succeed({ blocked: false, waiting_on: null })
  }

  const waitingOn = Object.hasOwn(patch, "waiting_on") ? patch.waiting_on : current.waiting_on
  if (waitingOn === null || waitingOn === undefined) {
    return Effect.fail(workError("invalid", "a blocked task must say what it waits on"))
  }
  return Effect.succeed({ blocked: true, waiting_on: waitingOn })
}

const BLOCK_STRIKE_LIMIT = 3

const taskChanged = (current: SpaceTask, next: SpaceTask): boolean =>
  mutableTaskFields.some((field) => current[field] !== next[field])

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

  const rememberBlock = Effect.fn("SqliteWorkStore.rememberBlock")(function* (
    itemId: string,
    reason: string
  ): Effect.fn.Return<number, WorkStoreError> {
    const rows = yield* sql<Pick<WorkItemRow, "block_count">>`
      UPDATE space_tasks
      SET block_count = CASE WHEN last_block_reason IS ${reason} THEN block_count + 1 ELSE 1 END,
          last_block_reason = ${reason}
      WHERE item_id = ${itemId}
      RETURNING block_count
    `.pipe(
      Effect.mapError((cause) =>
        workError("storage", "Could not record the Space task block", cause)
      )
    )
    const row = rows[0]
    if (row === undefined) return yield* workError("not_found", "Space task not found")
    return row.block_count
  })

  const forgetBlocks = (itemId: string): Effect.Effect<void, WorkStoreError> =>
    sql`
    UPDATE space_tasks
    SET block_count = 0, last_block_reason = NULL
    WHERE item_id = ${itemId}
  `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        workError("storage", "Could not clear the Space task blocks", cause)
      )
    )

  const breakBlockLoop = Effect.fn("SqliteWorkStore.breakBlockLoop")(function* (
    spaceId: string | null,
    itemId: string,
    reason: string,
    at: string
  ): Effect.fn.Return<void, WorkStoreError, UnitOfWork> {
    yield* taskEvent(spaceId, itemId, "block_loop", reason, at)
    return yield* spaceJobs
      .stopTask(itemId)
      .pipe(
        Effect.mapError((cause) => workError("storage", "Could not stop the Space task job", cause))
      )
  })

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
    patch: UpdateSpaceTaskPatch,
    actor: "user" | "worker",
    runId?: string,
    fromJob = false,
    toolCallId?: string
  ): Effect.fn.Return<SpaceTask, WorkStoreError> {
    const validPatch = yield* decodeUpdateSpaceTaskPatchEffect(patch).pipe(
      Effect.mapError((cause) => workError("invalid", "Invalid Space task update", cause))
    )
    const validRequest = yield* Schema.decodeUnknownEffect(InternalUpdateSpaceTaskRequestSchema)({
      expected_updated_at: expectedUpdatedAt,
      ...validPatch
    }).pipe(
      Effect.mapError((cause) =>
        workError("invalid", "Expected work task timestamp is invalid", cause)
      )
    )
    const expectedTimestamp = validRequest.expected_updated_at

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
          const ownAttempt = runId ? attemptOf !== undefined : actor === "worker"
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
          if (actor === "worker" && validPatch.token_budget !== undefined)
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
            actor === "worker" &&
            statusChanged &&
            status === "done" &&
            !validPatch.completion_result
          ) {
            return yield* workError(
              "invalid",
              "Worker completion must include completion_result in the same update"
            )
          }
          const completionResult =
            actor === "worker" && statusChanged && status === "done"
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
            candidate.runs_in === "chat" &&
            live &&
            (current.runs_in !== "chat" || current.status !== candidate.status)
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
          const finished = status === "done" || status === "cancelled"
          let completedAt = current.completed_at
          if (statusChanged) completedAt = finished ? updatedAt : null

          const blockReason =
            blockState.blocked && (!current.blocked || blockState.waiting_on !== current.waiting_on)
              ? blockState.waiting_on
              : null
          const strikes = blockReason === null ? 0 : yield* rememberBlock(row.item_id, blockReason)
          const stopped = blockReason !== null && strikes >= BLOCK_STRIKE_LIMIT
          if (statusChanged && status === "done") yield* forgetBlocks(row.item_id)

          const next = yield* Schema.decodeUnknownEffect(SpaceTaskSchema)({
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
            (next.runs_in === "chat" && current.runs_in !== "chat")
          )
            yield* ensureTaskBudget(sql, updatedRow.item_id, next.token_budget)
          const spent = yield* stopSpentTasks(
            { sql, sessionEvents },
            { itemId: updatedRow.item_id },
            updatedAt
          )

          const onlyScheduleChanged = mutableTaskFields
            .filter((field) => field !== "next_attempt_at")
            .every((field) => current[field] === next[field])
          const changeType = blockReason === null ? "updated" : "blocked"
          const statusEvent = statusChanged && finished ? next.status : changeType
          const eventType = onlyScheduleChanged ? "scheduled" : statusEvent
          if (publicChanged)
            yield* taskEvent(
              updatedRow.space_id,
              updatedRow.item_id,
              eventType,
              completionResult ??
                (next.blocked && validPatch.block_reason !== undefined
                  ? validPatch.block_reason
                  : undefined) ??
                summarizedTaskFields
                  .filter((field) => current[field] !== next[field])
                  .map((field) => {
                    switch (field) {
                      case "text":
                        return `Renamed Task to ${next.text}.`
                      case "body":
                        return "Task details updated."
                      case "status":
                        return `Status changed to ${next.status}.`
                      case "owner":
                        return next.owner === "worker" ? "Assigned to Arden." : "Assigned to you."
                      case "runs_in":
                        return next.runs_in === "chat"
                          ? "Arden works on it in its chat."
                          : "Arden works on it in the background."
                      case "token_budget":
                        return next.token_budget === null
                          ? "Token budget removed."
                          : `Token budget set to ${countOf(next.token_budget, "token")}.`
                      case "blocked":
                        return next.blocked ? "Task blocked." : "Task unblocked."
                      case "waiting_on":
                        return next.waiting_on === null
                          ? "Waiting cleared."
                          : `Waiting on ${next.waiting_on}.`
                      case "due_at":
                        return next.due_at === null
                          ? "Due date removed."
                          : `Due date set to ${next.due_at}.`
                      case "next_attempt_at":
                        return next.next_attempt_at === null
                          ? "Next check removed."
                          : `Next check scheduled for ${next.next_attempt_at}.`
                    }
                  })
                  .join(" "),
              updatedAt,
              runId,
              completionResult === undefined ? "summary" : "result",
              validPatch.completion_result
            )
          if (stopped)
            yield* breakBlockLoop(updatedRow.space_id, updatedRow.item_id, blockReason, updatedAt)
          if (current.text !== next.text)
            yield* renameOwnedJob(sql, taskJobId(updatedRow.item_id), next.text)

          if (status !== "open") {
            const settling = actor === "worker" && statusChanged && finished ? runId : undefined
            yield* spaceJobs.stopTask(updatedRow.item_id, settling)
          } else if (!ownAttempt || (current.runs_in === "chat" && next.runs_in === "background")) {
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
              !ownAttempt && !rescheduled
            )
          }

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
          cause instanceof WorkStoreError
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
      actor ?? (runId ? "worker" : "user"),
      runId,
      false,
      toolCallId
    )

  const stop: WorkStore["Service"]["stop"] = Effect.fn("SqliteWorkStore.stop")(
    function* (address, expectedUpdatedAt) {
      const task = yield* updateFor(
        address,
        expectedUpdatedAt,
        { status: "cancelled" },
        "user"
      ).pipe(
        Effect.catchTag("WorkStoreError", (error) => {
          if (error.reason !== "conflict") return Effect.fail(error)
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

  const commentFor = Effect.fn("SqliteWorkStore.commentFor")(function* (
    address: TaskAddress,
    input: CreateSpaceTaskCommentInput,
    actor: "user" | "worker",
    runId?: string
  ): Effect.fn.Return<SpaceTaskComment, WorkStoreError> {
    const valid = yield* decodeCreateSpaceTaskCommentInputEffect(input).pipe(
      Effect.mapError((cause) => workError("invalid", "Invalid Space task comment", cause))
    )
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const itemId = yield* resolveTaskItem(sql, address)
          const tasks = yield* sql<Pick<WorkItemRow, "item_id" | "space_id">>`
        SELECT item_id, space_id FROM space_tasks WHERE item_id = ${itemId}
      `
          const task = tasks[0]
          if (task === undefined) return yield* workError("not_found", "Space task not found")
          if (runId) yield* assertRunTaskAuthority(sql, runId, task.item_id)
          const rows = yield* sql<WorkCommentRow>`
        INSERT INTO space_task_comments (space_id, item_id, author, body, created_at, kind)
        VALUES (${task.space_id}, ${task.item_id}, ${actor}, ${valid.body}, ${now}, 'note')
        RETURNING comment_id, space_id, item_id, author, body, created_at, kind
      `
          const row = rows[0]
          if (row === undefined)
            return yield* workError("storage", "Space task comment insert returned no row")
          return yield* decodeWorkComment(row)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkStoreError
            ? cause
            : workError("storage", "Could not create Space task comment", cause)
        )
      )
  })

  const comment: WorkStore["Service"]["comment"] = (address, input, runId) =>
    commentFor(address, input, runId ? "worker" : "user", runId)

  const jobOrigin = Effect.fn("SqliteWorkStore.jobOrigin")(function* (
    originAutomationId: string
  ): Effect.fn.Return<
    {
      readonly spaceId: string | undefined
      readonly stableKey: string | null
      readonly itemId: string | null
    },
    WorkStoreError
  > {
    const rows = yield* sql<{
      readonly space_id: string | null
      readonly stable_key: string | null
      readonly item_id: string | null
    }>`
      SELECT coalesce(job.owner_space_id, chat.space_id) AS space_id, item.stable_key,
             job.owner_task_id AS item_id
      FROM scheduled_tasks AS job
      LEFT JOIN space_tasks AS item ON item.item_id = job.owner_task_id
      LEFT JOIN sessions AS chat ON ${userAutomationSql("job")}
        AND chat.session_id = job.thread_id AND chat.archived_at IS NULL
      WHERE job.task_id = ${originAutomationId}
        AND job.purpose IN ('user_automation', 'space_review', 'task_execution')
        AND (job.purpose != 'task_execution' OR item.item_id IS NOT NULL)
    `.pipe(
      Effect.mapError((cause) => workError("storage", "Could not resolve job ownership", cause))
    )
    const job = rows[0]
    if (!job) return yield* workError("invalid", "This job cannot change Tasks")
    return {
      spaceId: job.space_id ?? undefined,
      stableKey: job.stable_key,
      itemId: job.item_id
    }
  })

  const spaceChoiceWords = sql<{ readonly space_id: string; readonly name: string }>`
    SELECT space_id, name FROM spaces WHERE archived_at IS NULL ORDER BY name, space_id
  `.pipe(
    Effect.map(spaceChoices),
    Effect.mapError((cause) => workError("storage", "Could not list the Spaces", cause))
  )

  const jobSpace = Effect.fn("SqliteWorkStore.jobSpace")(function* (
    origin: { readonly spaceId: string | undefined },
    requestedSpaceId: string | undefined
  ): Effect.fn.Return<string, WorkStoreError> {
    const spaceId = requestedSpaceId ?? origin.spaceId
    if (spaceId === undefined)
      return yield* workError(
        "invalid",
        `This run's chat is in no Space, so name the Space for the Task. ${yield* spaceChoiceWords}`
      )
    if (requestedSpaceId === undefined) return spaceId
    const active = yield* sql`
      SELECT 1 FROM spaces WHERE space_id = ${requestedSpaceId} AND archived_at IS NULL
    `.pipe(Effect.mapError((cause) => workError("storage", "Could not validate the Space", cause)))
    if (active.length === 0)
      return yield* workError(
        "not_found",
        `No active Space has id '${requestedSpaceId}'. ${yield* spaceChoiceWords}`
      )
    return spaceId
  })

  const jobTarget = Effect.fn("SqliteWorkStore.jobTarget")(function* (
    originAutomationId: string,
    key: string,
    requestedSpaceId: string | undefined
  ): Effect.fn.Return<TaskAddress, WorkStoreError> {
    const origin = yield* jobOrigin(originAutomationId)
    if (origin.stableKey !== null && origin.stableKey !== key) {
      return yield* workError("invalid", "This job cannot mutate that Space task")
    }
    if (
      origin.spaceId !== undefined &&
      requestedSpaceId !== undefined &&
      requestedSpaceId !== origin.spaceId
    )
      return yield* workError("invalid", "This job can change only Tasks on its own Space")
    if (origin.itemId !== null) return { kind: "item", itemId: origin.itemId }
    return {
      kind: "key",
      scope: { kind: "space", spaceId: yield* jobSpace(origin, requestedSpaceId) },
      key
    }
  })

  const updateFromJob = Effect.fn("SqliteWorkStore.updateFromJob")(function* (
    originAutomationId: string,
    key: string,
    expectedUpdatedAt: string,
    patch: UpdateSpaceTaskPatch,
    requestedSpaceId?: string,
    runId?: string,
    toolCallId?: string
  ): Effect.fn.Return<SpaceTask, WorkStoreError> {
    const target = yield* jobTarget(originAutomationId, key, requestedSpaceId)
    return yield* updateFor(target, expectedUpdatedAt, patch, "worker", runId, true, toolCallId)
  })

  const commentFromJob = Effect.fn("SqliteWorkStore.commentFromJob")(function* (
    originAutomationId: string,
    key: string,
    input: CreateSpaceTaskCommentInput,
    requestedSpaceId?: string,
    runId?: string
  ): Effect.fn.Return<SpaceTaskComment, WorkStoreError> {
    const target = yield* jobTarget(originAutomationId, key, requestedSpaceId)
    return yield* commentFor(target, input, "worker", runId)
  })

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
                  cause._tag === "RecordedHistoryError" ? cause.reason : "storage",
                  "Could not read Task history",
                  cause
                )
          )
        ),
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
        .pipe(Effect.mapError((cause) => workError("storage", "Could not record the tell", cause))),
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
    comment,
    inferenceReview,
    finishCheck: makeFinishCheck(sql),
    updateFromJob,
    commentFromJob,
    ...makeWorkAttachments({ writer, sessionEvents })
  })
}
