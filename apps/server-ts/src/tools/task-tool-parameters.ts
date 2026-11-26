import { TaskPatchSchema } from "../persistence/work/task-patch.js"
import { KeyedTaskDraftSchema } from "../persistence/work/task-input.js"
import {
  SpaceTaskCaptureInputSchema,
  WorkTaskKeySchema
} from "@arden-hq/protocol/effect/spaces/work"
import { Schema } from "effect"
import {
  TASK_BODY_DESCRIPTION,
  TASK_OWNER_DESCRIPTION,
  TASK_TEXT_DESCRIPTION,
  TASK_USER_FACING
} from "./task-wording.js"
const OptionalSpaceIdSchema = Schema.optionalKey(
  Schema.NonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description:
      "Exact space_id from space_list. Omit to use this chat's Space. An Automation's own chat names the Space."
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

const patchFields = TaskPatchSchema.fields

const continuationContext = patchFields.continuation_context.annotate({
  description:
    "The Task's state record, which its next wake reads first: done (finished results, each with the record or link that shows it), in_progress (each job still running, with its handle: a run id, a PID, a URL), decided, rejected (each option turned down, with why) and next (the next concrete steps). Save it in the call that ends a wake. Each section given replaces that section; a section left out keeps what the record holds; null clears the record. At most 8 short lines a section; keep full evidence in referenced records. Saved atomically with this change; not shown as a Task update, and it does not change authority or override current Task fields and user instructions."
})

export const StartParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  capture: SpaceTaskCaptureInputSchema.annotate({
    description:
      "Why tracking is needed: explicit means the user asked to create or track a Task, or to keep working on something until it is done; long_horizon means ongoing ownership or later follow-up. Ordinary requests, complexity and tool count do not warrant a Task. Inferred capture is reserved for Space inference. Include one concrete reason."
  }),
  key: KeyedTaskDraftSchema.fields.key.pipe(
    Schema.annotateEncoded({
      description:
        "Stable lowercase key for later changes. Check space_board_read or task_get first: a live Task with this key makes the call fail."
    })
  ),
  text: KeyedTaskDraftSchema.fields.text.pipe(
    Schema.annotateEncoded({ description: TASK_TEXT_DESCRIPTION }),
    Schema.check(Schema.isMaxLength(80))
  ),
  body: KeyedTaskDraftSchema.fields.body.annotate({
    description: `${TASK_BODY_DESCRIPTION} Null clears the body.`
  }),
  owner: KeyedTaskDraftSchema.fields.owner.annotate({
    description: TASK_OWNER_DESCRIPTION
  }),
  runs_in: KeyedTaskDraftSchema.fields.runs_in.annotate({
    description:
      'Where Arden works on it. Omit for "background", the default: it runs on its own and reports back; use it for work expected to span hours or several wakes. "chat" keeps working on it here, turn after turn, until it is done or needs the user: use it for short work the user is steering in this chat.'
  }),
  token_budget: KeyedTaskDraftSchema.fields.token_budget.annotate({
    description: "A token cap across all of its runs. Set it only when the user asked for one."
  })
})

export const TaskGetParametersSchema = Schema.Struct({
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

const ChangePatchSchema = TaskPatchSchema.mapFields(
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

export const UpdateParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  key: TaskKeyParameterSchema,
  expected_updated_at: ExpectedUpdatedAtSchema,
  patch: ChangePatchSchema.pipe(
    Schema.annotateEncoded({ description: "Fields to change; provide at least one." })
  )
})

export const WaitParametersSchema = Schema.Struct({
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

export const FinishParametersSchema = Schema.Struct({
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

export const CommentParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  key: TaskKeyParameterSchema,
  body: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(600)).pipe(
    Schema.annotateEncoded({
      description: `One or two short sentences, at most 600 characters: what changed, then what it means or happens next. Link detailed evidence instead of narrating it. ${TASK_USER_FACING}`
    })
  )
})
