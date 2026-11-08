import {
  AUTOMATION_ACTIVITY_TRIGGERS,
  AUTOMATION_EVENT_TYPES,
  AUTOMATION_EVENTS,
  EVENT_TRIGGER_FIELDS
} from "@arden-hq/protocol/automations"
import {
  CountAutomationTriggerInputSchema,
  CreateAutomationInputSchema,
  EventAutomationTriggerInputSchema,
  IdleAutomationTriggerInputSchema,
  SystemAutomationSettingSchema,
  TimeAutomationTriggerInputSchema,
  UpdateAutomationInputSchema
} from "@arden-hq/protocol/effect/automations"
import { Effect, Schema } from "effect"
import { ApprovalModeSchema } from "../persistence/permissions/approval-policy.js"

export const EmptyParametersSchema = Schema.Record(Schema.String, Schema.Never)
const AutomationRefSchema = Schema.NonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description: "Exact automation_ref returned by automation_list."
})
const SessionRefSchema = Schema.NonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description: "Exact session_ref returned by session_list."
})
const ChatSchema = Schema.Literals(["current", "own"] as const).annotate({
  description:
    "Where it lives and reports. current: this chat, for follow-ups and checking back here, including in a Space room. own: a new chat of its own, for independent recurring work."
})

const TRIGGER_ID = {
  description:
    "A stored trigger's id (t1, t2, ...) from the Automation's text. Send it on update to keep that trigger: each field you leave out keeps its stored value, and null clears it. Leave it out for a new trigger and on create."
}

const TimeTriggerSchema = TimeAutomationTriggerInputSchema.mapFields(
  (fields) => ({
    id: fields.id.annotate(TRIGGER_ID),
    type: fields.type.annotate({ description: "Use time for a clock or interval schedule." }),
    at: fields.at.pipe(
      Schema.annotateEncoded({
        description:
          "24-hour machine-local time (H:mm or HH:mm). Use alone for the next occurrence, with on for one date, or with days to recur."
      })
    ),
    on: fields.on.pipe(
      Schema.annotateEncoded({
        description: "One machine-local date (YYYY-MM-DD); valid only with at and without days."
      })
    ),
    days: fields.days.pipe(
      Schema.annotateEncoded({
        description:
          "Recurring day set: daily, weekdays, weekends, or comma-separated mon..sun. Valid with at or every."
      })
    ),
    every: fields.every.pipe(
      Schema.annotateEncoded({
        description:
          "Interval of at least one minute, such as 30m, 2h, or 1d2h30m; use instead of at."
      })
    ),
    start: fields.start.pipe(
      Schema.annotateEncoded({
        description:
          "Optional machine-local interval-window start (H:mm or HH:mm); valid only with every."
      })
    ),
    end: fields.end.pipe(
      Schema.annotateEncoded({
        description:
          "Optional machine-local interval-window end (H:mm or HH:mm); valid only with every and after start when both are set."
      })
    )
  }),
  { unsafePreserveChecks: true }
)

const EventTriggerSchema = EventAutomationTriggerInputSchema.mapFields((fields) => ({
  id: fields.id.annotate(TRIGGER_ID),
  type: fields.type.annotate({
    description: "Use event to run when an application event happens."
  }),
  event_type: fields.event_type.pipe(
    Schema.annotateEncoded({
      description: AUTOMATION_EVENT_TYPES.map(
        (type) => `${type}: ${AUTOMATION_EVENTS[type].sentence}`
      ).join(" ")
    })
  ),
  lead_minutes: fields.lead_minutes.annotate({ description: EVENT_TRIGGER_FIELDS.lead_minutes }),
  mcp_event: fields.mcp_event.annotate({ description: EVENT_TRIGGER_FIELDS.mcp_event }),
  condition: Schema.optionalKey(Schema.Null).annotate({
    description:
      "Only null: removes this trigger's old field condition (shown as old condition). Leave it out to keep it; an old condition cannot be written."
  }),
  run_only_if: fields.run_only_if.annotate({ description: EVENT_TRIGGER_FIELDS.run_only_if })
}))

const IdleTriggerSchema = IdleAutomationTriggerInputSchema.mapFields((fields) => ({
  id: fields.id.annotate(TRIGGER_ID),
  type: fields.type.annotate({ description: AUTOMATION_ACTIVITY_TRIGGERS.idle.sentence }),
  idle_minutes: fields.idle_minutes.annotate({
    description: "Whole positive minutes without a new message from the user."
  })
}))

const CountTriggerSchema = CountAutomationTriggerInputSchema.mapFields((fields) => ({
  id: fields.id.annotate(TRIGGER_ID),
  type: fields.type.annotate({ description: AUTOMATION_ACTIVITY_TRIGGERS.count.sentence }),
  every_n: fields.every_n.annotate({
    description: "Whole positive number of chat turns in one chat."
  })
}))

const ToolAutomationTriggerSchema = Schema.Union([
  TimeTriggerSchema,
  EventTriggerSchema,
  IdleTriggerSchema,
  CountTriggerSchema
]).pipe(Schema.toTaggedUnion("type"))

const AutomationTriggersSchema = Schema.NonEmptyArray(ToolAutomationTriggerSchema).pipe(
  Schema.annotateEncoded({
    description:
      "One or more triggers, with at most one idle and one count trigger; any number of time or event triggers. Any trigger may start the Automation. Add several event triggers when one job answers more than one kind of event."
  })
)

export const CreateParametersSchema = CreateAutomationInputSchema.mapFields((fields) => ({
  name: fields.name.pipe(
    Schema.annotateEncoded({
      description: "Short human-readable Automation name."
    })
  ),
  prompt: fields.prompt.pipe(
    Schema.annotateEncoded({
      description: "Self-contained instructions executed on every run."
    })
  ),
  description: fields.description.pipe(
    Schema.annotateEncoded({
      description: "Optional user-facing summary, up to 220 characters."
    })
  ),
  model: fields.model.pipe(
    Schema.annotateEncoded({
      description:
        "Exact model id; omit for the Background model. An Automation that reads one of the user's chats runs on that chat's model and takes none."
    })
  ),
  history: fields.history.pipe(
    Schema.annotateEncoded({
      description:
        "fresh: each run starts with no history. chat: each run reads its chat's history, including earlier runs there."
    })
  ),
  chat: Schema.optionalKey(ChatSchema).annotate({
    description:
      "Where it lives and reports. Omit for own: a new chat of its own, the default for independent recurring work. current: this chat, when the user asks for results here, or for a reminder or check back on a request made in this conversation."
  }),
  chat_ref: Schema.optionalKey(SessionRefSchema).annotate({
    description:
      "One of the user's other chats or a Space room to live and report in instead. Omit chat."
  }),
  triggers: AutomationTriggersSchema,
  enabled: fields.enabled.annotate({
    description:
      "Defaults to true. Use false to create paused while configuring a report destination; enable with automation_update after setup succeeds."
  }),
  approval_mode: fields.approval_mode.annotate({
    description:
      "Action mode of its own chat: read_only, ask, safe, or allow. In one of the user's chats, that chat's mode applies."
  }),
  cooldown_minutes: fields.cooldown_minutes.annotate({
    description: "Minimum whole minutes between runs; null disables the cooldown. Defaults to null."
  }),
  reads: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))).annotate({
    description:
      "For the user's approval card only: what its runs read, in a few words (Calendar, Gmail, the web)."
  }),
  will_not: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))).annotate({
    description:
      "For the user's approval card only: what its instructions forbid, in a few words (send email, edit events)."
  })
}))

const UpdateChangesSchema = UpdateAutomationInputSchema.mapFields(
  (fields) => ({
    chat: Schema.optionalKey(ChatSchema),
    chat_ref: Schema.optionalKey(SessionRefSchema).annotate({
      description:
        "Move future runs to this exact chat or Space room from session_list. Not while a run is active."
    }),
    history: fields.history.pipe(
      Schema.annotateEncoded({
        description:
          "fresh: each run starts with no history. chat: each run reads its chat's history. Past runs keep theirs."
      })
    ),
    action_mode: Schema.optionalKey(ApprovalModeSchema).annotate({
      description:
        "Set the action mode of the chat its runs are in: read_only, ask, safe, or allow. In one of the user's chats this changes that chat's mode."
    }),
    name: fields.name.pipe(
      Schema.annotateEncoded({
        description: "Replacement human-readable Automation name."
      })
    ),
    prompt: fields.prompt.pipe(
      Schema.annotateEncoded({
        description: "Replacement self-contained instructions executed on every run."
      })
    ),
    description: fields.description.pipe(
      Schema.annotateEncoded({
        description: "Replacement user-facing summary, up to 220 characters."
      })
    ),
    model: fields.model.pipe(
      Schema.annotateEncoded({
        description:
          "Exact model id, or null for the Background model. When it reads one of the user's chats, this changes that chat's model instead."
      })
    ),
    triggers: Schema.optionalKey(AutomationTriggersSchema),
    enabled: fields.enabled.annotate({
      description:
        "Set false to pause for now or true to resume. A finished job is deleted, not paused."
    }),
    cooldown_minutes: fields.cooldown_minutes.annotate({
      description: "Replacement minimum whole minutes between runs; null disables the cooldown."
    }),
    reset_to_default: Schema.optionalKey(SystemAutomationSettingSchema).annotate({
      description:
        "System Automations only: put triggers, model, prompt or enabled back to its default, in a separate call."
    }),
    pause_at_percent: Schema.optionalKey(
      Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 100 })))
    ).annotate({
      description:
        "This Automation's own plan limit: it pauses once the plan reaches this percent, and never later than the user's background limit. null removes it. Set only when the user asks."
    }),
    max_tokens_per_run: Schema.optionalKey(
      Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 10_000, maximum: 100_000_000 })))
    ).annotate({
      description:
        "Most tokens one run of this Automation may use; a run that reaches it stops. null removes it. Set only when the user asks."
    })
  }),
  { unsafePreserveChecks: true }
)

export const RefParametersSchema = Schema.Struct({ automation_ref: AutomationRefSchema })

export const RunsParametersSchema = Schema.Struct({
  automation_ref: AutomationRefSchema,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
    .annotate({
      description: "Maximum recent runs to return, from 1 to 200. Defaults to 20."
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(20)))
})

export const UpdateParametersSchema = Schema.Struct({
  automation_ref: AutomationRefSchema,
  changes: UpdateChangesSchema.pipe(
    Schema.annotateEncoded({
      description: "Only the Automation fields to change."
    })
  )
})
