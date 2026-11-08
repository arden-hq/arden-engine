import { cutText } from "@arden-hq/std/text"
import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError, type ToolContext, type ToolResultOutput } from "@arden-hq/loop"
import {
  taskActivityWords,
  type SpaceTask,
  type UpdateSpaceTaskPatch
} from "@arden-hq/protocol/spaces/work"
import type { TodoListItem } from "@arden-hq/protocol"
import {
  CreateSpaceTaskInputSchema,
  SpaceTaskCaptureInputSchema,
  UpdateSpaceTaskPatchSchema,
  WorkTaskKeySchema
} from "@arden-hq/protocol/effect/spaces/work"
import { Effect, Schema } from "effect"
import {
  TASK_BODY_DESCRIPTION,
  TASK_SPACE_RULE,
  TASK_OWNER_DESCRIPTION,
  TASK_TEXT_DESCRIPTION,
  TASK_USER_FACING
} from "./task-wording.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { refuseCapChange, saveCap, tokenBudgetCard } from "./task-token-cap.js"
import { SessionQueries, type SessionQueryFailure } from "../persistence/sessions/queries.js"
import {
  WorkStore,
  WorkStoreError,
  type TaskExecutionReceipt,
  type TaskScope
} from "../persistence/work/store.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { noSpace } from "./spaces.js"
import { toolFailure } from "./tool-failure.js"
import { taskHandle } from "./task-handle.js"
import { askUserQuestion } from "./ask-user-input.js"
import type { ServerRunContext } from "./run-context.js"
import { workTarget, type WorkTarget } from "./work-reach.js"
import { recordApplied, type CallEffects } from "../execution/tool-effect.js"
import { actsAsPerson, rootOf } from "../execution/authority.js"
import { refusalError } from "./refusal.js"
import { appliedReceipt } from "./call-receipt.js"
import type { OriginalRequest } from "../persistence/todos/items.js"

const OptionalSpaceIdSchema = Schema.optionalKey(
  Schema.NonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description:
      "Exact space_id from space_list. Omit to use this chat's Space, or this chat when it is in no Space. An Automation's own chat names the Space."
  })
)

const TaskKeyParameterSchema = WorkTaskKeySchema.pipe(
  Schema.annotateEncoded({
    description: "Exact key from task_get or space_board_read."
  })
)

const ExpectedUpdatedAtSchema = Schema.NonEmptyString.annotate({
  description:
    "Exact updated_at from task_get or space_board_read; a stale value rejects the change."
})

const patchFields = UpdateSpaceTaskPatchSchema.fields

const continuationContext = patchFields.continuation_context.annotate({
  description:
    "The Task's state record, which its next wake reads first: done (finished results, each with the record or link that shows it), in_progress (each job still running, with its handle: a run id, a PID, a URL), decided, rejected (each option turned down, with why) and next (the next concrete steps). Save it in the call that ends a wake. Each section given replaces that section; a section left out keeps what the record holds; null clears the record. At most 8 short lines a section; keep full evidence in referenced records. Saved atomically with this change; not shown as a Task update, and it does not change authority or override current Task fields and user instructions."
})

const StartParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  capture: SpaceTaskCaptureInputSchema.annotate({
    description:
      "Why tracking is needed: explicit means the user asked to create or track a Task, or to keep working on something until it is done; long_horizon means ongoing ownership or later follow-up. Ordinary requests, complexity and tool count do not warrant a Task. Inferred capture is reserved for Space inference. Include one concrete reason."
  }),
  key: CreateSpaceTaskInputSchema.fields.key.pipe(
    Schema.annotateEncoded({
      description:
        "Stable lowercase key for later changes. Check space_board_read or task_get first: a live Task with this key makes the call fail."
    })
  ),
  text: CreateSpaceTaskInputSchema.fields.text.pipe(
    Schema.annotateEncoded({ description: TASK_TEXT_DESCRIPTION }),
    Schema.check(Schema.isMaxLength(80))
  ),
  body: CreateSpaceTaskInputSchema.fields.body.annotate({
    description: `${TASK_BODY_DESCRIPTION} Null clears the body.`
  }),
  owner: CreateSpaceTaskInputSchema.fields.owner.annotate({
    description: TASK_OWNER_DESCRIPTION
  }),
  runs_in: CreateSpaceTaskInputSchema.fields.runs_in.annotate({
    description:
      'Where Arden works on it. Omit for "background", the default: it runs on its own and reports back; use it for work expected to span hours or several wakes. "chat" keeps working on it here, turn after turn, until it is done or needs the user: use it for short work the user is steering in this chat.'
  }),
  token_budget: CreateSpaceTaskInputSchema.fields.token_budget.annotate({
    description: "A token cap across all of its runs. Set it only when the user asked for one."
  })
})

const TaskGetParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  key: Schema.optionalKey(TaskKeyParameterSchema).annotate({
    description: "Exact key of the Task. Omit to read the Task this chat works on."
  }),
  item_id: Schema.optionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description:
        "Exact item_id from a Task event: reads that Task wherever it is, a chat's own Task too. Only the user's own chats and their Automations read by item_id; other runs use key. Use it instead of space_id and key."
    })
  )
}).check(
  Schema.makeFilter((input) =>
    input.item_id !== undefined && (input.key !== undefined || input.space_id !== undefined)
      ? { path: ["item_id"], issue: "pass item_id alone, without space_id or key" }
      : undefined
  )
)

const ChangePatchSchema = UpdateSpaceTaskPatchSchema.mapFields(
  () => ({
    continuation_context: continuationContext,
    text: patchFields.text.pipe(
      Schema.annotateEncoded({ description: `Replacement row. ${TASK_TEXT_DESCRIPTION}` }),
      Schema.check(Schema.isMaxLength(80))
    ),
    body: patchFields.body.annotate({
      description: `Replacement longer Task context; null clears it. ${TASK_USER_FACING}`
    }),
    status: Schema.optionalKey(Schema.Literals(["open", "deferred"] as const)).annotate({
      description:
        "open reopens or resumes it; deferred puts it aside. Finish it with task_finish instead."
    }),
    owner: patchFields.owner.annotate({
      description: `Replacement owner. ${TASK_OWNER_DESCRIPTION}`
    }),
    runs_in: patchFields.runs_in.annotate({
      description:
        'Where Arden works on it: "chat" in its own chat, "background" on its own. Move it to the background when it turns out to span hours or several wakes, or when the user turns to something else in this chat; say so in one line.'
    }),
    due_at: patchFields.due_at.annotate({
      description: "Display-only due text, up to 512 characters. Null clears it."
    }),
    token_budget: patchFields.token_budget.annotate({
      description:
        "A token cap across all of its runs; null removes it. Change it alone, in its own call; raising or removing it asks the user on a card. A Task its spent cap stopped goes on when the new cap is above what it has used."
    })
  }),
  { unsafePreserveChecks: true }
)

const UpdateParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  key: TaskKeyParameterSchema,
  expected_updated_at: ExpectedUpdatedAtSchema,
  patch: ChangePatchSchema.pipe(
    Schema.annotateEncoded({ description: "Fields to change; provide at least one." })
  )
})

const WaitParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  key: TaskKeyParameterSchema,
  expected_updated_at: ExpectedUpdatedAtSchema,
  waiting_on: Schema.optionalKey(Schema.Literals(["you", "external"] as const)).annotate({
    description:
      "Who must act before it can go on: you (the user) or external (someone or something outside). Needs block_reason. Omit to only book next_attempt_at."
  }),
  block_reason: patchFields.block_reason.pipe(
    Schema.annotateEncoded({
      description:
        'With waiting_on: the one concrete thing that unblocks this Task, as a direct instruction to whoever must act — "Reconnect Gmail for tim@example.com", "Sign in to LinkedIn in the in-app browser", "Wait for Greenhouse to reopen the role". Never describe your own state ("I need something", "blocked on input").'
    })
  ),
  next_attempt_at: patchFields.next_attempt_at.annotate({
    description: "ISO-8601 time to look at it again. Null clears a booked check."
  }),
  continuation_context: continuationContext
})

const FinishParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  key: TaskKeyParameterSchema,
  expected_updated_at: ExpectedUpdatedAtSchema,
  status: Schema.Literals(["done", "cancelled"] as const).annotate({
    description:
      "done when its outcome is reached; cancelled when it duplicates another Task or no distinct outcome remains."
  }),
  completion_result: patchFields.completion_result.pipe(
    Schema.annotateEncoded({
      description:
        "Required with done. One sentence, at most 140 characters: what came out of it first, then the one thing still open that needs the user, if any. Name the thing, not the contents of the packet. Link the report instead of describing it; the Task's peek has the rest. Requires completion_evidence. Save complete reports with task_save_result first. A draft does not fulfill an explicit requirement to publish elsewhere."
    })
  ),
  completion_evidence: patchFields.completion_evidence.annotate({
    description:
      "Required with done: saved Task attachment IDs or confirmed current-run write tool_call_ids, each with the requirement it fulfills. Failed/uncertain writes and reads are rejected."
  }),
  completion_note: patchFields.completion_note.pipe(
    Schema.annotateEncoded({
      description:
        "Required if a write failed: briefly explain how it was recovered or why it was optional. Visible to the user. If required publication is still missing, keep the Task open."
    })
  )
})

const CommentParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  key: TaskKeyParameterSchema,
  body: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(600)).pipe(
    Schema.annotateEncoded({
      description: `One or two short sentences, at most 600 characters: what changed, then what it means or happens next. Link detailed evidence instead of narrating it. ${TASK_USER_FACING}`
    })
  )
})

export const workFailure = (error: WorkStoreError): ToolExecutionError =>
  toolFailure(error, error.reason === "conflict" ? "Task changed" : "Task update failed")

const updateFailure = (error: WorkStoreError): ToolExecutionError =>
  error.reason === "conflict"
    ? new ToolExecutionError(
        `${error.message}. Read it again with task_get, check what changed, and retry with the updated_at shown there only if your change still applies.`,
        { preview: "Task changed", retryable: true }
      )
    : toolFailure(error, "Task update failed")

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

const resolveWorkTarget = async (
  services: TaskToolServices,
  { run, signal }: ToolContext<ServerRunContext>,
  requestedSpaceId: string | undefined,
  crossSpace: "refuse" | "handoff"
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
    op: crossSpace === "handoff" ? "create" : "change"
  })
  if (decision.kind === "target") {
    const target = decision.target
    if (target.kind === "space" && requestedSpaceId !== undefined) {
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
  if (decision.reason === "no_space") throw await noSpace(services, undefined, signal)
  throw refusalError({
    what: WORK_REFUSAL[decision.reason],
    rule: "boundary",
    instead: decision.instead
  })
}

const scopeOf = (target: Exclude<WorkTarget, { readonly kind: "job" }>): TaskScope =>
  target.kind === "space"
    ? { kind: "space", spaceId: target.spaceId }
    : { kind: "chat", sessionId: target.sessionId }

const WORK_REFUSAL = {
  outside_job_space:
    "A job (an Automation, a Space's Task or review, and their agents) changes only Work owned by its own Space; it may start a Task on another Space",
  outside_delegated_space: "An agent changes Work only on the Space of the chat that started it",
  unrecorded: "This run's authority was not recorded, so it cannot change Work"
} as const

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

const refuseWidePatch = (patch: UpdateSpaceTaskPatch, ownTask: boolean): void => {
  const refused = Object.keys(patch).filter((field) => {
    if (field === "status") return patch.status !== "done" && patch.status !== "cancelled"
    if (field === "body") return !ownTask
    return !jobPatchFields.has(field)
  })
  if (refused.length === 0) return
  throw new ToolExecutionError(
    `A run cannot set ${refused.join(", ")} on a Task. It may finish or cancel it (task_finish), ` +
      "wait on something external or book a next check (task_wait), save internal continuation_context, and change its own Task's body. Other fields belong " +
      "to the user — raise it with task_comment instead.",
    { preview: "Field not writable by a run", retryable: false }
  )
}

const startFailure = (error: WorkStoreError): ToolExecutionError =>
  error.reason === "conflict"
    ? new ToolExecutionError(
        `${error.message}. Change it with task_update, task_wait or task_finish and its key instead of starting it again.`,
        { preview: "Task key already exists", retryable: false }
      )
    : workFailure(error)

const namedLink = (label: string, url: string): string =>
  `[${label.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")}](${url})`

const taskUrl = (task: { readonly item_id: string }): string =>
  `arden:task/${encodeURIComponent(task.item_id)}`

interface TaskUpdateConfirmation {
  readonly result: string
  readonly preview: string
}

const taskUpdateConfirmation = (
  task: { readonly item_id: string; readonly text: string },
  patch: UpdateSpaceTaskPatch
): TaskUpdateConfirmation => {
  const link = namedLink(task.text, taskUrl(task))
  if (patch.completion_result !== undefined) {
    return {
      result: [patch.completion_result, patch.completion_note, link]
        .filter((part): part is string => part !== undefined)
        .join("\n\n"),
      preview: "Task completed"
    }
  }
  if (patch.blocked === true)
    return { result: `${link} waits: ${patch.block_reason ?? ""}`, preview: "Task waiting" }
  if (patch.status === undefined) {
    return { result: `Saved changes to ${link}.`, preview: "Task changes saved" }
  }
  switch (patch.status) {
    case "cancelled":
      return {
        result: `Marked ${link} cancelled. Its other runs lose their authority and end at their next step.`,
        preview: "Task marked cancelled"
      }
    case "deferred":
      return {
        result: `Deferred ${link}. Any active run stops separately.`,
        preview: "Task deferred"
      }
    case "done":
      return {
        result: `Marked ${link} done. Its other runs lose their authority and end at their next step.`,
        preview: "Task marked done"
      }
    case "open":
      return { result: `Reopened ${link}.`, preview: "Task reopened" }
  }
}

const executionWords = (receipt: TaskExecutionReceipt): string => {
  switch (receipt.kind) {
    case "saved":
      return "Saved; execution has not started or been queued."
    case "queued":
      return "Work queued; it has not started yet."
    case "working":
      return "Working now."
    case "scheduled":
      return `Next check scheduled for ${receipt.at}.`
    case "inactive":
      return `Current state: ${receipt.state}.`
  }
}

const activityNote = (task: SpaceTask): string => {
  const words = task.status === "open" ? taskActivityWords(task) : undefined
  return words === undefined ? "" : `, ${words}`
}

const taskState = (task: SpaceTask): string =>
  [
    `${namedLink(task.text, taskUrl(task))} (${taskHandle(task)})`,
    `Status: ${task.status}${task.blocked ? `, waiting on ${task.waiting_on ?? "you"}` : ""}${activityNote(task)}; runs in ${task.runs_in === "chat" ? "its chat" : "the background"}; owner ${task.owner}.`,
    ...(task.token_budget === null ? [] : [`Token budget: ${task.token_budget}.`]),
    ...(task.next_attempt_at === null ? [] : [`Next check: ${task.next_attempt_at}.`]),
    ...(task.body === null ? [] : ["", task.body])
  ].join("\n")

export const readTaskAt = async (
  services: TaskToolServices,
  ctx: ToolContext<ServerRunContext>,
  spaceId: string | undefined,
  key: string
): Promise<SpaceTask> => {
  const target = await resolveWorkTarget(services, ctx, spaceId, "refuse")
  return Effect.runPromise(
    (target.kind === "job"
      ? services.work.getFromJob(target.automationId, key, target.spaceId)
      : services.work.get({ kind: "key", scope: scopeOf(target), key })
    ).pipe(Effect.mapError(workFailure)),
    { signal: ctx.signal }
  )
}

const REQUEST_QUOTE_LIMIT = 2_000

const finishWarning = (
  open: ReadonlyArray<TodoListItem>,
  request: OriginalRequest | undefined
): string =>
  [
    "Not finished: the Task is still open. Your todo list has open items:",
    ...open.map((item) => `- [${item.status}] ${item.content}`),
    ...(request === undefined ? [] : [requestLine(request)]),
    "Do them, or mark each cancelled with its reason in todo_update, then finish. Calling task_finish again in this run closes it as it stands, with the open items listed as still open."
  ].join("\n")

const requestLine = (request: OriginalRequest): string => {
  const text = cutText(request.text, REQUEST_QUOTE_LIMIT)
  switch (request.kind) {
    case "message":
      return `The request (user message ${request.messageId}): ${JSON.stringify(text)}`
    case "snapshot":
      return `The Task as first written: ${JSON.stringify(text)}`
    case "current":
      return `The Task: ${JSON.stringify(text)}`
  }
}

const fromWorker = (target: WorkTarget, ctx: ToolContext<ServerRunContext>): boolean =>
  target.kind === "job" || rootOf(ctx.run.authority.actor) === "task_worker"

const applyTaskChange = async (
  services: TaskToolServices,
  input: {
    readonly space_id?: string | undefined
    readonly key: string
    readonly expected_updated_at: string
    readonly patch: UpdateSpaceTaskPatch
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
  const patch: UpdateSpaceTaskPatch = asksUser ? rest : input.patch
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
      data: { question }
    }
  }
  if (updated === undefined) throw new Error("A Task change without a question saves the Task")
  const execution = await Effect.runPromise(services.work.execution(updated.item_id), {
    signal: ctx.signal
  })
  const confirmation = taskUpdateConfirmation(updated, patch)
  return {
    result: `${confirmation.result}\n\n${taskHandle(updated)}`,
    preview: confirmation.preview,
    data: { task: updated, execution, task_url: taskUrl(updated) }
  }
}

export const taskWriteMetadata = (displayName: string, preview: string) =>
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
        return { result: taskState(task), preview: task.text, data: { task } }
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
        return { result: taskState(task), preview: task.text, data: { task } }
      }
      const task = await readTaskAt(services, ctx, input.space_id, input.key)
      return { result: taskState(task), preview: task.text, data: { task } }
    }
  }),
  defineServerTool({
    name: "task_start",
    description: `Start one Task: on this chat's Space, in this chat when it is in no Space, or on a named Space. A key that names a live Task is refused (change that Task instead); a key that names an archived Task revives it. Only the user's own chats and their Automations start Tasks. ${TASK_SPACE_RULE}`,
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
        result: `Started ${namedLink(task.text, taskUrl(task))} (${taskHandle(task)}). ${where}`,
        preview: task.text,
        data: { task, execution, task_url: taskUrl(task) }
      }
    }
  }),
  defineServerTool({
    name: "task_update",
    description:
      "Change one Task: its text, details, owner, where it runs, whether it is open or put aside, its due text, or its internal continuation_context. To wait on someone or book a later check use task_wait; to finish or cancel it use task_finish. A Task run may change only its own Task's details and continuation_context.",
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
      const patch: UpdateSpaceTaskPatch = {
        ...rest,
        ...(waiting_on === undefined ? {} : { blocked: true, waiting_on })
      }
      return applyTaskChange(services, { space_id, key, expected_updated_at, patch }, ctx, effects)
    }
  }),
  defineServerTool({
    name: "task_finish",
    description:
      "Finish one Task: done when its outcome is reached, with completion_result and completion_evidence; cancelled when it duplicates another Task or no distinct outcome remains. A message alone never finishes a Task. Cancel it directly rather than asking the user to operate the Task menu.",
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
                ctx.run.runId
              )
            : services.work.comment(
                { kind: "key", scope: scopeOf(target), key: input.key },
                comment,
                ctx.run.runId
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
