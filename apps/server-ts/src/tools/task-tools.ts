import type { TaskPatch } from "../persistence/work/task-patch.js"
import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError, type ToolContext, type ToolResultOutput } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { TASK_SPACE_RULE } from "./task-wording.js"
import {
  CommentParametersSchema,
  FinishParametersSchema,
  StartParametersSchema,
  TaskGetParametersSchema,
  UpdateParametersSchema,
  WaitParametersSchema
} from "./task-tool-parameters.js"
import { defineServerTool, type ServerTool, type ServerToolMetadataInput } from "./define.js"
import { refuseCapChange, saveCap, tokenBudgetCard } from "./task-token-cap.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { WorkStore } from "../persistence/work/store.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { toolFailure } from "./tool-failure.js"
import { taskHandle } from "./task-handle.js"
import {
  executionWords,
  finishWarning,
  namedLink,
  taskState,
  taskUpdateConfirmation,
  taskUrl
} from "./task-tool-words.js"
import { askUserQuestion, questionData } from "./ask-user-input.js"
import type { ServerRunContext } from "./run-context.js"
import { recordApplied, type CallEffects } from "../execution/tool-effect.js"
import { actsAsPerson, rootOf } from "../execution/authority.js"
import { appliedReceipt } from "./call-receipt.js"
import {
  fromWorker,
  readTaskAt,
  refuseWidePatch,
  resolveWorkTarget,
  scopeOf,
  startFailure,
  updateFailure,
  workFailure,
  type TaskToolServices
} from "./task-work-access.js"

const applyTaskChange = async (
  services: TaskToolServices,
  input: {
    readonly space_id?: string | undefined
    readonly key: string
    readonly expected_updated_at: string
    readonly patch: TaskPatch
  },
  ctx: ToolContext<ServerRunContext>,
  effects: CallEffects
): Promise<ToolResultOutput> => {
  const cap = input.patch.token_budget
  const target = await resolveWorkTarget(services, ctx, input.space_id, "refuse")
  if (cap !== undefined) refuseCapChange(input.patch, fromWorker(target, ctx))
  const asksUser = target.kind === "job" && input.patch.waiting_on === "you"
  const {
    blocked: _blocked,
    waiting_on: _waitingOn,
    block_reason: blockReason,
    ...rest
  } = input.patch
  const patch: TaskPatch = asksUser ? rest : input.patch
  if (asksUser && blockReason === undefined)
    throw new ToolExecutionError(
      "Say what you need from the user: set block_reason to one direct question or instruction. It reaches them as a question, and their answer resumes the Task.",
      { preview: "block_reason required", retryable: true }
    )
  if (target.kind === "job") {
    const own = ctx.run.authority.owns.task_item_id !== null
    refuseWidePatch(patch, own && rootOf(ctx.run.authority.actor) === "task_worker")
  }
  if (patch.blocked === true && patch.block_reason === undefined) {
    throw new ToolExecutionError(
      'Say what unblocks it: set block_reason to one direct instruction, such as "Reconnect Gmail for tim@example.com" or "Sign in to LinkedIn in the in-app browser".',
      { preview: "block_reason required", retryable: true }
    )
  }
  const save = () => {
    if (target.kind === "job")
      return services.work.updateFromJob(
        target.automationId,
        input.key,
        input.expected_updated_at,
        patch,
        target.spaceId,
        ctx.run.runId,
        ctx.toolCallId
      )
    const address = { kind: "key", scope: scopeOf(target), key: input.key } as const
    const run = { runId: ctx.run.runId, toolCallId: ctx.toolCallId }
    return cap === undefined
      ? services.work.update(address, input.expected_updated_at, patch, run.runId, run.toolCallId)
      : saveCap(services.work, address, cap, run)
  }
  const updated =
    asksUser && Object.keys(patch).length === 0
      ? undefined
      : await recordApplied(
          effects,
          Effect.runPromise(save().pipe(Effect.mapError(updateFailure)), { signal: ctx.signal })
        )
  if (asksUser && blockReason !== undefined) {
    const question = await recordApplied(
      effects,
      Effect.runPromise(
        services.work
          .askQuestion({
            runId: ctx.run.runId,
            toolCallId: ctx.toolCallId,
            content: askUserQuestion({ prompt: blockReason, detail: null }).content,
            reuseOpenTaskQuestion: true
          })
          .pipe(Effect.mapError((error) => toolFailure(error, "Question not asked"))),
        { signal: ctx.signal }
      )
    )
    return {
      result: `The Task is waiting on question_id ${question.question_id}; the user sees it as a card, and answering it resumes the Task.${updated === undefined ? "" : " The other fields were saved."} Continue independent work, or end this Run while waiting for the answer.`,
      preview: question.content.prompt,
      data: questionData(question)
    }
  }
  if (updated === undefined) throw new Error("A Task change without a question saves the Task")
  const execution = await Effect.runPromise(services.work.execution(updated.item_id), {
    signal: ctx.signal
  })
  const confirmation = taskUpdateConfirmation(updated, patch)
  return {
    result: `${confirmation.result}\n\n${taskHandle(ctx.run, updated)}`,
    preview: confirmation.preview,
    data: { task: updated, execution, task_url: taskUrl(updated) }
  }
}

export const taskWriteMetadata = (displayName: string, preview: string): ServerToolMetadataInput =>
  ({
    effect: "arden_db",
    scopes: ["worker", "agent_research", "agent_code"],
    display_name: displayName,
    kind: "tool",
    action: "write",
    approval_preview: preview,
    source: "_spaces",
    changes_state: true,
    target: "reported",
    concurrency_group: "space_work",
    destructive: false
  }) as const

const makeTaskTools = (services: TaskToolServices): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "task_get",
    summary: "Reads a Task.",
    discovery: { group: "tasks" },
    description:
      "Read one Task: the Task this chat works on, one by key, or (in the user's own chats and their Automations) one by the item_id a Task event names. It returns what the Task asks, where it stands, and the key and updated_at the change tools take.",
    parameters: Schema.toStandardSchemaV1(TaskGetParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Read Task",
      kind: "tool",
      action: "read",
      approval_preview: "Read a Task.",
      source: "_spaces",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      if (input.item_id !== undefined) {
        if (!actsAsPerson(ctx.run.authority.actor))
          throw new ToolExecutionError(
            "Only the user's own runs and their Automations read a Task by item_id. Read a Task on this run's Space with task_get(key=...), or space_board_read.",
            { preview: "Task not read", retryable: false }
          )
        const task = await Effect.runPromise(
          services.work
            .get({ kind: "item", itemId: input.item_id })
            .pipe(
              Effect.mapError((error) =>
                error.reason === "not_found"
                  ? new ToolExecutionError(
                      `No Task has item_id ${JSON.stringify(input.item_id)}; it may have been deleted. Find it with space_board_read.`,
                      { preview: "Task not found", retryable: false }
                    )
                  : workFailure(error)
              )
            ),
          { signal: ctx.signal }
        )
        return { result: taskState(ctx.run, task), preview: task.text, data: { task } }
      }
      if (input.key === undefined) {
        const current = await Effect.runPromise(
          services.work
            .chatTask(ctx.run.sessionId)
            .pipe(Effect.mapError((error) => toolFailure(error, "Task unavailable"))),
          { signal: ctx.signal }
        )
        if (current === undefined)
          return {
            result:
              "This chat works on no Task. Name one by key, or read the board with space_board_read.",
            preview: "No Task here"
          }
        const task = await Effect.runPromise(
          services.work
            .get({ kind: "item", itemId: current.task.itemId })
            .pipe(Effect.mapError(workFailure)),
          { signal: ctx.signal }
        )
        return { result: taskState(ctx.run, task), preview: task.text, data: { task } }
      }
      const task = await readTaskAt(services, ctx, input.space_id, input.key)
      return { result: taskState(ctx.run, task), preview: task.text, data: { task } }
    }
  }),
  defineServerTool({
    name: "task_start",
    summary: "Starts a Task.",
    discovery: { group: "tasks" },
    description: `Start one Task: on this chat's Space or on a named Space. A key that names a live Task is refused (change that Task instead); a key that names an archived Task revives it. Only the user's own chats and their Automations start Tasks. ${TASK_SPACE_RULE}`,
    parameters: Schema.toStandardSchemaV1(StartParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Start Task",
      kind: "tool",
      action: "write",
      approval_preview: "Start a Task.",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      concurrency_group: "space_work",
      destructive: false
    },
    execute: async (input, ctx, effects) => {
      const target = await resolveWorkTarget(services, ctx, input.space_id, "handoff")
      if (target.kind === "job") throw new Error("A background run cannot start a Task")
      const { space_id: _spaceId, capture, ...taskInput } = input
      const task = await recordApplied(
        effects,
        Effect.runPromise(
          services.work
            .createFromChat({
              scope: scopeOf(target),
              input: taskInput,
              sessionId: ctx.run.sessionId,
              runId: ctx.run.runId,
              toolCallId: ctx.toolCallId,
              capture
            })
            .pipe(Effect.mapError(startFailure)),
          { signal: ctx.signal }
        )
      )
      const execution = await Effect.runPromise(services.work.execution(task.item_id), {
        signal: ctx.signal
      })
      const where =
        task.runs_in === "chat"
          ? "It works in this chat: keep going on it now, turn after turn, until it is done or needs the user."
          : executionWords(execution)
      return {
        result: `Started ${namedLink(task.text, taskUrl(task))} (${taskHandle(ctx.run, task)}). ${where}`,
        preview: task.text,
        data: { task, execution, task_url: taskUrl(task) }
      }
    }
  }),
  defineServerTool({
    name: "task_update",
    summary: "Changes a Task.",
    discovery: { group: "tasks" },
    description:
      "Change one Task: its text, details, owner, where it runs, whether it is open or put aside, its due text, its token_budget, or its internal continuation_context. Change token_budget alone in its own call; raising or removing it asks the user. To wait on someone or book a later check use task_wait; to finish or cancel it use task_finish. A Task run may change only its own Task's details and continuation_context.",
    parameters: Schema.toStandardSchemaV1(UpdateParametersSchema),
    metadata: { ...taskWriteMetadata("Update Task", "Change a Task."), approval_bypass: true },
    approvalRequirement: async (input, ctx) => {
      const cap = input.patch.token_budget
      if (cap === undefined) return undefined
      const target = await resolveWorkTarget(services, ctx, input.space_id, "refuse")
      refuseCapChange(input.patch, fromWorker(target, ctx))
      if (target.kind === "job") return undefined
      const address = { kind: "key", scope: scopeOf(target), key: input.key } as const
      return Effect.runPromise(
        tokenBudgetCard(services.work, address, { key: input.key, cap }).pipe(
          Effect.mapError(workFailure)
        ),
        { signal: ctx.signal }
      )
    },
    execute: (input, ctx, effects) =>
      applyTaskChange(
        services,
        input.patch.status === "open"
          ? { ...input, patch: { ...input.patch, blocked: false } }
          : input,
        ctx,
        effects
      )
  }),
  defineServerTool({
    name: "task_wait",
    summary: "Makes a Task wait for someone or for later.",
    discovery: { group: "tasks" },
    description:
      "Make one Task wait: on the user or something external until the one thing in block_reason happens, or until next_attempt_at. A Task run waiting on the user reuses its open question, or asks block_reason if none is open; their answer resumes the Task. Use ask_user when the user must decide; do not wait on recoverable failures or pending work.",
    parameters: Schema.toStandardSchemaV1(WaitParametersSchema),
    metadata: taskWriteMetadata("Task waits", "Make a Task wait."),
    execute: (input, ctx, effects) => {
      const { space_id, key, expected_updated_at, waiting_on, ...rest } = input
      if (waiting_on === undefined && rest.block_reason !== undefined)
        throw new ToolExecutionError("block_reason goes with waiting_on: say who must act.", {
          preview: "waiting_on required",
          retryable: true
        })
      if (waiting_on === undefined && rest.next_attempt_at === undefined)
        throw new ToolExecutionError(
          "Say what it waits for: waiting_on with block_reason, or next_attempt_at.",
          { preview: "Nothing to wait for", retryable: true }
        )
      const patch: TaskPatch = {
        ...rest,
        ...(waiting_on === undefined ? {} : { blocked: true, waiting_on })
      }
      return applyTaskChange(services, { space_id, key, expected_updated_at, patch }, ctx, effects)
    }
  }),
  defineServerTool({
    name: "task_finish",
    summary: "Finishes or cancels a Task.",
    discovery: { group: "tasks" },
    description:
      "Finish one Task: done when its outcome is reached, with completion_result and completion_evidence (and completion_note if a write failed); cancelled when it duplicates another Task or no distinct outcome remains. If your todo list still has open items, the first done call changes nothing and lists them; a second done call in this run closes the Task anyway. A message alone never finishes a Task. Cancel it directly rather than asking the user to operate the Task menu.",
    parameters: Schema.toStandardSchemaV1(FinishParametersSchema),
    metadata: taskWriteMetadata("Finish Task", "Finish a Task."),
    execute: async (input, ctx, effects) => {
      const { space_id, key, expected_updated_at, ...patch } = input
      const change = { space_id, key, expected_updated_at, patch }
      if (patch.status !== "done") return applyTaskChange(services, change, ctx, effects)
      const task = await readTaskAt(services, ctx, space_id, key)
      const check = await Effect.runPromise(
        services.work
          .finishCheck({ runId: ctx.run.runId, itemId: task.item_id })
          .pipe(Effect.mapError(workFailure)),
        { signal: ctx.signal }
      )
      if (check.kind === "warn")
        return {
          result: finishWarning(check.open, check.request),
          preview: `Not finished: ${countOf(check.open.length, "open todo item")}`,
          data: { finish_check: { ...check.record } }
        }
      const done = await applyTaskChange(services, change, ctx, effects)
      return { ...done, data: { ...done.data, finish_check: { ...check.record } } }
    }
  }),
  defineServerTool({
    name: "task_comment",
    summary: "Adds a note to a Task.",
    discovery: { group: "tasks" },
    description:
      "Add a note to one Task's history. A note is never the Task's result: a Task run's outcome is its final response, or completion_result when it finishes the Task. Comments never answer questions or wake work; use ask_user for a question.",
    parameters: Schema.toStandardSchemaV1(CommentParametersSchema),
    metadata: {
      effect: "arden_db",
      scopes: ["worker", "observer", "agent_research", "agent_code"],
      display_name: "Comment on Task",
      kind: "tool",
      action: "write",
      approval_preview: "Comment on a Task.",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      concurrency_group: "space_work",
      destructive: false
    },
    execute: async (input, ctx, effects) => {
      const target = await resolveWorkTarget(services, ctx, input.space_id, "refuse")
      const task = await readTaskAt(services, ctx, input.space_id, input.key)
      const comment = { body: input.body }
      const added = await recordApplied(
        effects,
        Effect.runPromise(
          (target.kind === "job"
            ? services.work.commentFromJob(
                target.automationId,
                input.key,
                comment,
                target.spaceId,
                ctx.run.runId,
                ctx.toolCallId
              )
            : services.work.comment(
                { kind: "key", scope: scopeOf(target), key: input.key },
                comment,
                ctx.run.runId,
                ctx.toolCallId
              )
          ).pipe(Effect.mapError(workFailure)),
          { signal: ctx.signal }
        )
      )
      return {
        result: `Added a ${namedLink("Task comment", taskUrl(added))}.`,
        preview: input.body,
        data: { comment: added, task_url: taskUrl(added) },
        host: appliedReceipt(ctx, {
          kind: "target",
          resourceRef: `task:${task.item_id}`,
          domain: "task",
          title: task.text,
          href: taskUrl(task)
        })
      }
    }
  })
]

export const taskTools = Effect.gen(function* () {
  return makeTaskTools({
    work: yield* WorkStore,
    sessions: yield* SessionQueries,
    spaces: yield* SpaceStore
  })
})
