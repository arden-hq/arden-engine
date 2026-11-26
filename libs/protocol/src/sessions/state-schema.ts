import { Schema } from "effect"
import { LINK } from "../common/links.js"
import {
  SESSION_EXECUTION_LABEL,
  SESSION_OWNER,
  SESSION_PRESENTATION,
  SESSION_PRESENTATION_ROLE
} from "./presentation.js"
import {
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  RuntimeRunStatusSchema,
  SessionTypeSchema,
  withExtras
} from "../common/schema.js"
import {
  SESSION_TRIAGE_DECISION,
  SESSION_TRIAGE_STATE,
  type SessionTriageDecision
} from "./contracts.js"
import {
  ACTIVITY_TEXT,
  AGENT_WORKSPACE,
  FIRST_LINE,
  PARENT_MESSAGE,
  SESSION_ACTIVITY,
  SESSION_FORK,
  SESSION_MODEL,
  SESSION_NAME,
  SESSION_ORIGIN,
  SESSION_PARENT,
  SESSION_PARENT_STEP,
  SESSION_RUN,
  SESSION_SPACE,
  SESSION_SUMMARY,
  THREAD_SOURCE
} from "./states.js"

const tagged = <const Kind extends string>(kind: Kind) =>
  Schema.Struct({ kind: Schema.Literal(kind) })

const sessionNameSchema = <Name extends Schema.Top>(name: Name) =>
  Schema.Union([
    tagged(SESSION_NAME.unnamed),
    Schema.Struct({ kind: Schema.Literal(SESSION_NAME.named), name })
  ])

export const SessionNameSchema = sessionNameSchema(Schema.String)

const sessionSpaceSchema = <Id extends Schema.Top>(id: Id) =>
  Schema.Union([
    tagged(SESSION_SPACE.none),
    Schema.Struct({ kind: Schema.Literal(SESSION_SPACE.space), space_id: id })
  ])

export const SessionSpaceSchema = sessionSpaceSchema(Schema.String)

const sessionChatModelSchema = <Id extends Schema.Top>(id: Id) =>
  Schema.Union([
    tagged(SESSION_MODEL.inherited),
    Schema.Struct({ kind: Schema.Literal(SESSION_MODEL.pinned), model_id: id })
  ])

export const SessionChatModelSchema = sessionChatModelSchema(Schema.String)

const InputTextSchema = Schema.Trimmed.check(Schema.isMinLength(1))

export const SessionNameInputSchema = sessionNameSchema(InputTextSchema)

export const SessionSpaceInputSchema = sessionSpaceSchema(Schema.NonEmptyString)

export const SessionChatModelInputSchema = sessionChatModelSchema(InputTextSchema)

export const SessionOriginSchema = Schema.Literals([
  SESSION_ORIGIN.ordinary,
  SESSION_ORIGIN.capture,
  SESSION_ORIGIN.onboarding
] as const)

export const ParentMessageSchema = Schema.Union([
  tagged(PARENT_MESSAGE.whole),
  Schema.Struct({
    kind: Schema.Literal(PARENT_MESSAGE.message),
    message_id: Schema.NonEmptyString
  })
])

export const LinkedAutomationSchema = Schema.Union([
  tagged(LINK.none),
  Schema.Struct({ kind: Schema.Literal(LINK.automation), automation_id: Schema.NonEmptyString })
])

export const SessionParentSchema = Schema.Union([
  tagged(SESSION_PARENT.none),
  Schema.Struct({
    kind: Schema.Literal(SESSION_PARENT.agent),
    session_id: Schema.NonEmptyString,
    run_id: Schema.NonEmptyString,
    tool_call_id: Schema.NonEmptyString,
    step: Schema.Union([
      tagged(SESSION_PARENT_STEP.none),
      Schema.Struct({
        kind: Schema.Literal(SESSION_PARENT_STEP.step),
        tool_call_id: Schema.NonEmptyString
      })
    ])
  }),
  Schema.Struct({
    kind: Schema.Literal(SESSION_PARENT.chat),
    session_id: Schema.NonEmptyString,
    message: ParentMessageSchema
  })
])

const SessionRunSchema = Schema.Union([
  tagged(SESSION_RUN.none),
  Schema.Struct({
    kind: Schema.Literal(SESSION_RUN.active),
    run_id: Schema.NonEmptyString,
    turn_id: Schema.NonEmptyString,
    status: RuntimeRunStatusSchema
  }),
  Schema.Struct({
    kind: Schema.Literal(SESSION_RUN.settled),
    run_id: Schema.NonEmptyString,
    status: RuntimeRunStatusSchema
  })
])

export const SessionPresentationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(SESSION_PRESENTATION.conversation),
    role: Schema.Literals(Object.values(SESSION_PRESENTATION_ROLE))
  }),
  Schema.Struct({
    kind: Schema.Literal(SESSION_PRESENTATION.execution),
    label: Schema.Literals(Object.values(SESSION_EXECUTION_LABEL)),
    title: Schema.NonEmptyString,
    owner: Schema.Union([
      tagged(SESSION_OWNER.none),
      Schema.Struct({
        kind: Schema.Literals([
          SESSION_OWNER.space,
          SESSION_OWNER.task,
          SESSION_OWNER.automation,
          SESSION_OWNER.session
        ]),
        id: Schema.NonEmptyString,
        name: Schema.NonEmptyString
      })
    ])
  })
])

const SessionTriageTargetSchema = Schema.Struct({
  space_id: Schema.NonEmptyString,
  title: Schema.String
})

export const SessionTriageDecisionSchema: Schema.Codec<SessionTriageDecision> = Schema.Union([
  Schema.Struct({
    decision: Schema.Literal(SESSION_TRIAGE_DECISION.move),
    target: SessionTriageTargetSchema,
    new_title: Schema.Null,
    rationale: Schema.String
  }),
  Schema.Struct({
    decision: Schema.Literal(SESSION_TRIAGE_DECISION.create),
    target: Schema.Null,
    new_title: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    rationale: Schema.String
  }),
  Schema.Struct({
    decision: Schema.Literal(SESSION_TRIAGE_DECISION.none),
    target: Schema.Null,
    new_title: Schema.Null,
    rationale: Schema.String
  }),
  Schema.Struct({
    decision: Schema.Literal(SESSION_TRIAGE_DECISION.moved),
    target: SessionTriageTargetSchema,
    new_title: Schema.Null,
    rationale: Schema.String
  })
])

const ActivityTextSchema = Schema.Union([
  tagged(ACTIVITY_TEXT.unstated),
  Schema.Struct({ kind: Schema.Literal(ACTIVITY_TEXT.stated), text: Schema.String })
])

export const FirstLineSchema = Schema.Union([
  tagged(FIRST_LINE.none),
  Schema.Struct({ kind: Schema.Literal(FIRST_LINE.line), text: Schema.String })
])

const sessionListFields = {
  session_id: Schema.String,
  public_ref: Schema.String,
  presentation: SessionPresentationSchema,
  name: SessionNameSchema,
  started_at: IsoDateTimeStringSchema,
  last_activity: IsoDateTimeStringSchema,
  has_unread: Schema.Boolean,
  message_count: NonNegativeIntSchema,
  space: SessionSpaceSchema,
  chat_model: SessionChatModelSchema,
  session_type: SessionTypeSchema,
  origin_automation: LinkedAutomationSchema,
  parent: SessionParentSchema,
  run: SessionRunSchema,
  checkpoint_seq: NonNegativeIntSchema,
  latest_event_seq: NonNegativeIntSchema,
  pending_approvals_count: NonNegativeIntSchema,
  pending_connections_count: NonNegativeIntSchema,
  triage: Schema.Union([
    tagged(SESSION_TRIAGE_STATE.none),
    Schema.Struct({
      kind: Schema.Literal(SESSION_TRIAGE_STATE.decided),
      decision: SessionTriageDecisionSchema
    })
  ]),
  fork: Schema.Union([
    tagged(SESSION_FORK.none),
    Schema.Struct({
      kind: Schema.Literal(SESSION_FORK.fork),
      at: IsoDateTimeStringSchema,
      turn_id: Schema.NonEmptyString
    })
  ]),
  thread_source: Schema.Union([
    tagged(THREAD_SOURCE.none),
    Schema.Struct({
      kind: Schema.Literal(THREAD_SOURCE.thread),
      session_id: Schema.NonEmptyString,
      session_ref: Schema.NonEmptyString
    }),
    Schema.Struct({ kind: Schema.Literal(THREAD_SOURCE.gone), session_id: Schema.NonEmptyString })
  ]),
  origin: SessionOriginSchema,
  current_activity: Schema.Union([
    tagged(SESSION_ACTIVITY.idle),
    Schema.Struct({
      kind: Schema.Literal(SESSION_ACTIVITY.running),
      run_id: Schema.String,
      sequence: NonNegativeIntSchema,
      purpose: ActivityTextSchema,
      run_purpose: ActivityTextSchema,
      operations: Schema.Array(Schema.Struct({ id: Schema.String, text: ActivityTextSchema }))
    })
  ])
}

export const SessionListItemSchema = withExtras(sessionListFields)

export const ListedSessionSchema = withExtras({
  ...sessionListFields,
  summary: Schema.Union([
    tagged(SESSION_SUMMARY.none),
    Schema.Struct({ kind: Schema.Literal(SESSION_SUMMARY.summary), text: Schema.String })
  ]),
  agent_workspace: Schema.Union([
    tagged(AGENT_WORKSPACE.none),
    Schema.Struct({ kind: Schema.Literal(AGENT_WORKSPACE.workspace), path: Schema.String })
  ])
})
