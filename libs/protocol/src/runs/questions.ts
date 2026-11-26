import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, NonNegativeIntSchema } from "../common/schema.js"
import { RunContextSchema } from "./context.js"
import { RunCursorPageNextSchema } from "./list-options.js"

const identity = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1024))
const text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(8000))

export const QUESTION_TEXT = { none: "none", given: "given" } as const

const givenText = <S extends Schema.Top>(given: S) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal(QUESTION_TEXT.none) }),
    Schema.Struct({ kind: Schema.Literal(QUESTION_TEXT.given), text: given })
  ])

export const RunQuestionContentSchema = Schema.Struct({
  prompt: text,
  detail: givenText(text),
  choices: Schema.Array(
    Schema.Struct({
      id: identity,
      label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
      detail: givenText(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(240)))
    })
  ).check(
    Schema.isMaxLength(6),
    Schema.makeFilter((choices) =>
      new Set(choices.map((choice) => choice.id)).size === choices.length
        ? undefined
        : "choice ids must be unique"
    )
  ),
  multiple: Schema.Boolean
})

const uniqueIds = Schema.makeFilter((ids: ReadonlyArray<string>) =>
  new Set(ids).size === ids.length ? undefined : "choice ids must be unique"
)

export const RUN_QUESTION_ANSWER = {
  text: "text",
  choice: "choice",
  choices: "choices",
  hold: "hold",
  dismiss: "dismiss",
  wait: "wait"
} as const

export const RunQuestionAnswerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_ANSWER.text), text }),
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_ANSWER.choice), choice_id: identity }),
  Schema.Struct({
    kind: Schema.Literal(RUN_QUESTION_ANSWER.choices),
    choice_ids: Schema.Array(identity).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(6),
      uniqueIds
    ),
    typed: givenText(text)
  }),
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_ANSWER.hold) }),
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_ANSWER.dismiss) })
])

export const QUESTION_RESOLUTION = { unresolved: "unresolved", resolved: "resolved" } as const

const resolutionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(QUESTION_RESOLUTION.unresolved) }),
  Schema.Struct({
    kind: Schema.Literal(QUESTION_RESOLUTION.resolved),
    client_id: identity,
    answer: RunQuestionAnswerSchema,
    resolved_at: IsoDateTimeStringSchema
  })
])

export const ANSWER_WITHDRAWAL_REASON = {
  executionAllowanceUnavailable: "execution_allowance_unavailable",
  destinationDeleted: "destination_deleted",
  taskChanged: "task_changed",
  spacePolicyChanged: "space_policy_changed"
} as const

export type AnswerWithdrawalReason =
  (typeof ANSWER_WITHDRAWAL_REASON)[keyof typeof ANSWER_WITHDRAWAL_REASON]

export const AnswerWithdrawalReasonSchema = Schema.Literals(Object.values(ANSWER_WITHDRAWAL_REASON))

export const RUN_QUESTION_CONTINUATION = {
  none: "none",
  queued: "queued",
  steering: "steering",
  steered: "steered",
  started: "started",
  withdrawn: "withdrawn"
} as const

const continuationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_CONTINUATION.none) }),
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_CONTINUATION.queued) }),
  Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_CONTINUATION.steering), run_id: identity }),
  Schema.Struct({
    kind: Schema.Literal(RUN_QUESTION_CONTINUATION.steered),
    run_id: identity,
    at: IsoDateTimeStringSchema
  }),
  Schema.Struct({
    kind: Schema.Literal(RUN_QUESTION_CONTINUATION.started),
    run_id: identity,
    at: IsoDateTimeStringSchema
  }),
  Schema.Struct({
    kind: Schema.Literal(RUN_QUESTION_CONTINUATION.withdrawn),
    reason: AnswerWithdrawalReasonSchema,
    at: IsoDateTimeStringSchema
  })
])

export const QUESTION_PART = { none: "none", present: "present" } as const

const optionalPart = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal(QUESTION_PART.none) }),
    Schema.Struct({ kind: Schema.Literal(QUESTION_PART.present), ...fields })
  ])

export const RULE_SAVED_IN = { space: "space", system: "system", everywhere: "everywhere" } as const

export const RuleSavedInSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RULE_SAVED_IN.space), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal(RULE_SAVED_IN.system) }),
  Schema.Struct({ kind: Schema.Literal(RULE_SAVED_IN.everywhere) })
])
export type RuleSavedIn = typeof RuleSavedInSchema.Type
export const isRuleSavedIn = Schema.is(RuleSavedInSchema)

export const OFFER_TOOL = { other: "other", tool: "tool" } as const
export const OFFER_SAVED = { unsaved: "unsaved", saved: "saved" } as const

export const RunQuestionPermissionOfferSchema = optionalPart({
  tool: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(OFFER_TOOL.other) }),
    Schema.Struct({ kind: Schema.Literal(OFFER_TOOL.tool), tool_name: identity })
  ]),
  saved: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(OFFER_SAVED.unsaved) }),
    Schema.Struct({ kind: Schema.Literal(OFFER_SAVED.saved), place: RuleSavedInSchema })
  ])
})

export const RUN_QUESTION_STATUS = {
  open: "open",
  suspended: "suspended",
  closed: "closed",
  resolved: "resolved"
} as const

export type RunQuestionStatus = (typeof RUN_QUESTION_STATUS)[keyof typeof RUN_QUESTION_STATUS]

export const RUN_QUESTION_TIMER_STATUS = {
  pending: "pending",
  elapsed: "elapsed",
  cancelled: "cancelled"
} as const

export const FOCUS_CHOICE_OFFER = { offered: "offered", settled: "settled" } as const

export const CONTRACT_PROPOSAL_CHANGE = {
  add: "add",
  replace: "replace",
  remove: "remove"
} as const

const timerSchema = optionalPart({
  expires_at: IsoDateTimeStringSchema,
  seconds: Schema.Int.check(Schema.isGreaterThan(0)),
  fallback_choice_id: identity,
  status: Schema.Literals(Object.values(RUN_QUESTION_TIMER_STATUS))
})

export const RunQuestionSchema = Schema.Struct({
  question_id: identity,
  run_id: identity,
  turn_id: identity,
  session_id: identity,
  destination_session_id: identity,
  context: RunContextSchema,
  content: RunQuestionContentSchema,
  status: Schema.Literals(Object.values(RUN_QUESTION_STATUS)),
  resolution: resolutionSchema,
  continuation: continuationSchema,
  focus_choice: optionalPart({
    space_id: identity,
    revision: NonNegativeIntSchema,
    status: Schema.Literals(Object.values(FOCUS_CHOICE_OFFER))
  }),
  permission_offer: RunQuestionPermissionOfferSchema,
  contract_proposal: optionalPart({
    item_id: identity,
    task: Schema.String,
    change: Schema.Literals(Object.values(CONTRACT_PROPOSAL_CHANGE)),
    line: Schema.String
  }),
  source_title: optionalPart({ title: Schema.String }),
  continuity: optionalPart({ revision: NonNegativeIntSchema }),
  created_at: IsoDateTimeStringSchema,
  timer: timerSchema
}).check(
  Schema.makeFilter((question) =>
    question.timer.kind === QUESTION_PART.none ||
    (question.content.choices[0]?.id === question.timer.fallback_choice_id &&
      !question.content.multiple &&
      question.focus_choice.kind === QUESTION_PART.none &&
      question.permission_offer.kind === QUESTION_PART.none)
      ? undefined
      : "timers require an ordinary single-choice question and its first choice as fallback"
  ),
  Schema.makeFilter((question) =>
    (question.status === RUN_QUESTION_STATUS.resolved) ===
    (question.resolution.kind === QUESTION_RESOLUTION.resolved)
      ? undefined
      : "resolved questions must have exactly one resolution"
  )
)

export const RunQuestionListSchema = Schema.Struct({
  questions: Schema.Array(RunQuestionSchema),
  next: RunCursorPageNextSchema
})
export const ResolveRunQuestionInputSchema = Schema.Struct({
  client_id: identity,
  answer: Schema.Union([
    RunQuestionAnswerSchema,
    Schema.Struct({ kind: Schema.Literal(RUN_QUESTION_ANSWER.wait) })
  ])
})

type RunQuestionAnswer = typeof RunQuestionAnswerSchema.Type
export type QuestionText = (typeof RunQuestionContentSchema.Type)["detail"]

export interface AnswerSaid {
  readonly chosen: ReadonlyArray<string>
  readonly typed: QuestionText
}

const typedText = (value: string): QuestionText => {
  const trimmed = value.trim()
  return trimmed.length === 0
    ? { kind: QUESTION_TEXT.none }
    : { kind: QUESTION_TEXT.given, text: trimmed }
}

export const answerSaid = (
  choices: ReadonlyArray<{ readonly id: string; readonly label: string }>,
  answer: RunQuestionAnswer
): AnswerSaid | undefined => {
  const labelsOf = (ids: ReadonlyArray<string>): ReadonlyArray<string> => [
    ...choices.filter((choice) => ids.includes(choice.id)).map((choice) => choice.label),
    ...ids.filter((id) => !choices.some((choice) => choice.id === id))
  ]
  switch (answer.kind) {
    case RUN_QUESTION_ANSWER.text:
      return { chosen: [], typed: { kind: QUESTION_TEXT.given, text: answer.text.trim() } }
    case RUN_QUESTION_ANSWER.choice:
      return { chosen: labelsOf([answer.choice_id]), typed: { kind: QUESTION_TEXT.none } }
    case RUN_QUESTION_ANSWER.choices:
      return {
        chosen: labelsOf(answer.choice_ids),
        typed:
          answer.typed.kind === QUESTION_TEXT.none ? answer.typed : typedText(answer.typed.text)
      }
    case RUN_QUESTION_ANSWER.hold:
    case RUN_QUESTION_ANSWER.dismiss:
      return undefined
  }
}

export const answerWords = (said: AnswerSaid): string =>
  [said.chosen.join(", "), said.typed.kind === QUESTION_TEXT.given ? said.typed.text : ""]
    .filter((part) => part.length > 0)
    .join("; ")

export type RunQuestion = typeof RunQuestionSchema.Type
export type RunQuestionContent = typeof RunQuestionContentSchema.Type
export type RunQuestionAnswerValue = RunQuestionAnswer
export type RunQuestionList = typeof RunQuestionListSchema.Type
export type ResolveRunQuestionInput = typeof ResolveRunQuestionInputSchema.Type

export const encodeResolveRunQuestionEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ResolveRunQuestionInputSchema)(value, {
    onExcessProperty: "error"
  }).pipe(Effect.map(JSON.stringify))

export const settledQuestionDrawn = (
  question: Pick<typeof RunQuestionSchema.Type, "status">
): boolean => question.status === RUN_QUESTION_STATUS.resolved
