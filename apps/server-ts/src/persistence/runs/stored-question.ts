import { AnswerWithdrawalReasonSchema, RuleSavedInSchema } from "@arden-hq/protocol/effect/runs"
import { IsoDateTimeStringSchema, NonNegativeIntSchema } from "@arden-hq/protocol/effect/common"
import {
  OFFER_SAVED,
  answerSaid,
  answerWords,
  type AnswerSaid,
  OFFER_TOOL,
  QUESTION_PART,
  QUESTION_RESOLUTION,
  QUESTION_TEXT,
  RUN_QUESTION_STATUS,
  type QuestionText,
  type ResolveRunQuestionInput,
  type RunQuestion,
  type RunQuestionAnswerValue,
  type RunQuestionList
} from "@arden-hq/protocol/runs"
import { Schema } from "effect"
import { RunContextSchema, wireRunContext } from "./stored-context.js"

const ANSWER_KIND = { choices: "choices" } as const
const CONTINUATION_NONE = "none"

const identity = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1024))
const text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(8000))
export const StoredRunQuestionContentSchema = Schema.Struct({
  prompt: text.pipe(
    Schema.annotateEncoded({ description: "One specific question that needs the user's decision." })
  ),
  detail: Schema.NullOr(text).annotate({
    description: "Relevant draft or context, or null if the question is self-contained."
  }),
  choices: Schema.Array(
    Schema.Struct({
      id: identity.pipe(Schema.annotateEncoded({ description: "Stable choice identifier." })),
      label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)).pipe(
        Schema.annotateEncoded({ description: "Short label shown on the answer button." })
      ),
      detail: Schema.optionalKey(
        Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(240)).pipe(
          Schema.annotateEncoded({
            description: "One plain line under the label saying what this choice means."
          })
        )
      )
    })
  )
    .check(
      Schema.isMaxLength(6),
      Schema.makeFilter((choices) =>
        new Set(choices.map((choice) => choice.id)).size === choices.length
          ? undefined
          : "choice ids must be unique"
      )
    )
    .pipe(
      Schema.annotateEncoded({
        description: "Up to six choices; use an empty array for a free-text answer."
      })
    ),
  multiple: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "True when the user may pick more than one choice." })
  )
})

const uniqueIds = Schema.makeFilter((ids: ReadonlyArray<string>) =>
  new Set(ids).size === ids.length ? undefined : "choice ids must be unique"
)

const StoredRunQuestionAnswerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text }),
  Schema.Struct({ kind: Schema.Literal("choice"), choice_id: identity }),
  Schema.Struct({
    kind: Schema.Literal("choices"),
    choice_ids: Schema.Array(identity).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(6),
      uniqueIds
    ),
    text: Schema.optionalKey(text)
  }),
  Schema.Struct({ kind: Schema.Literal("hold") }),
  Schema.Struct({ kind: Schema.Literal("dismiss") })
])

const resolutionSchema = Schema.Struct({
  client_id: identity,
  answer: StoredRunQuestionAnswerSchema,
  resolved_at: IsoDateTimeStringSchema
})

const continuationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("queued") }),
  Schema.Struct({ kind: Schema.Literal("steering"), run_id: identity }),
  Schema.Struct({ kind: Schema.Literal("steered"), run_id: identity, at: IsoDateTimeStringSchema }),
  Schema.Struct({ kind: Schema.Literal("started"), run_id: identity, at: IsoDateTimeStringSchema }),
  Schema.Struct({
    kind: Schema.Literal("withdrawn"),
    reason: AnswerWithdrawalReasonSchema,
    at: IsoDateTimeStringSchema
  })
])

const RunQuestionFocusChoiceSchema = Schema.Struct({
  space_id: identity,
  revision: NonNegativeIntSchema,
  status: Schema.Literals(["offered", "settled"] as const)
})

const RunQuestionPermissionOfferSchema = Schema.Struct({
  tool_name: Schema.NullOr(identity),
  saved_in: Schema.NullOr(RuleSavedInSchema)
})

const RunQuestionContractProposalSchema = Schema.Struct({
  item_id: identity,
  task: Schema.String,
  change: Schema.Literals(["add", "replace", "remove"]),
  line: Schema.String
})

export const StoredRunQuestionSchema = Schema.Struct({
  question_id: identity,
  run_id: identity,
  turn_id: identity,
  session_id: identity,
  destination_session_id: identity,
  context: RunContextSchema,
  content: StoredRunQuestionContentSchema,
  status: Schema.Literals(["open", "suspended", "closed", "resolved"]),
  resolution: Schema.NullOr(resolutionSchema),
  continuation: Schema.NullOr(continuationSchema),
  focus_choice: Schema.NullOr(RunQuestionFocusChoiceSchema),
  permission_offer: Schema.NullOr(RunQuestionPermissionOfferSchema),
  contract_proposal: Schema.optionalKey(RunQuestionContractProposalSchema),
  source_title: Schema.optionalKey(Schema.String),
  continuity_revision: Schema.NullOr(NonNegativeIntSchema),
  created_at: IsoDateTimeStringSchema,
  timer: Schema.optionalKey(
    Schema.Struct({
      expires_at: IsoDateTimeStringSchema,
      seconds: Schema.Int.check(Schema.isGreaterThan(0)),
      fallback_choice_id: identity,
      status: Schema.Literals(["pending", "elapsed", "cancelled"])
    })
  )
}).check(
  Schema.makeFilter((question) =>
    question.timer === undefined ||
    (question.content.choices[0]?.id === question.timer.fallback_choice_id &&
      question.content.multiple !== true &&
      question.focus_choice === null &&
      question.permission_offer === null)
      ? undefined
      : "timers require an ordinary single-choice question and its first choice as fallback"
  ),
  Schema.makeFilter((question) =>
    (question.status === RUN_QUESTION_STATUS.resolved) === (question.resolution !== null)
      ? undefined
      : "resolved questions must have exactly one resolution"
  )
)

export type StoredRunQuestion = typeof StoredRunQuestionSchema.Type
export type StoredRunQuestionAnswer = typeof StoredRunQuestionAnswerSchema.Type
export type StoredRunQuestionContent = typeof StoredRunQuestionContentSchema.Type

export const StoredResolveInputSchema = Schema.Struct({
  client_id: identity,
  answer: Schema.Union([
    StoredRunQuestionAnswerSchema,
    Schema.Struct({ kind: Schema.Literal("wait") })
  ])
})
export type StoredResolveAnswer = StoredRunQuestionAnswer | { readonly kind: "wait" }

export interface StoredRunQuestionList {
  readonly questions: ReadonlyArray<StoredRunQuestion>
  readonly next: RunQuestionList["next"]
}

export interface StoredResolveInput {
  readonly client_id: string
  readonly answer: StoredResolveAnswer
}

const given = (value: string | null | undefined): QuestionText =>
  value === null || value === undefined
    ? { kind: QUESTION_TEXT.none }
    : { kind: QUESTION_TEXT.given, text: value }

const part = <T extends object>(value: T | null | undefined) =>
  value === null || value === undefined
    ? { kind: QUESTION_PART.none }
    : { kind: QUESTION_PART.present, ...value }

const wireRunQuestionAnswer = (answer: StoredRunQuestionAnswer): RunQuestionAnswerValue => {
  if (answer.kind !== ANSWER_KIND.choices) return answer
  return { kind: answer.kind, choice_ids: answer.choice_ids, typed: given(answer.text) }
}

export const storedResolveAnswer = (
  answer: ResolveRunQuestionInput["answer"]
): StoredResolveAnswer => {
  if (answer.kind !== ANSWER_KIND.choices) return answer
  return {
    kind: answer.kind,
    choice_ids: answer.choice_ids,
    ...(answer.typed.kind === QUESTION_TEXT.none ? {} : { text: answer.typed.text })
  }
}

export const storedResolveInput = (input: ResolveRunQuestionInput): StoredResolveInput => ({
  client_id: input.client_id,
  answer: storedResolveAnswer(input.answer)
})

export const wireRunQuestion = (question: StoredRunQuestion): RunQuestion => ({
  question_id: question.question_id,
  run_id: question.run_id,
  turn_id: question.turn_id,
  session_id: question.session_id,
  destination_session_id: question.destination_session_id,
  context: wireRunContext(question.context),
  content: {
    prompt: question.content.prompt,
    detail: given(question.content.detail),
    choices: question.content.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      detail: given(choice.detail)
    })),
    multiple: question.content.multiple === true
  },
  status: question.status,
  resolution:
    question.resolution === null
      ? { kind: QUESTION_RESOLUTION.unresolved }
      : {
          kind: QUESTION_RESOLUTION.resolved,
          client_id: question.resolution.client_id,
          answer: wireRunQuestionAnswer(question.resolution.answer),
          resolved_at: question.resolution.resolved_at
        },
  continuation: question.continuation ?? { kind: CONTINUATION_NONE },
  focus_choice: part(question.focus_choice),
  permission_offer:
    question.permission_offer === null
      ? { kind: QUESTION_PART.none }
      : {
          kind: QUESTION_PART.present,
          tool:
            question.permission_offer.tool_name === null
              ? { kind: OFFER_TOOL.other }
              : { kind: OFFER_TOOL.tool, tool_name: question.permission_offer.tool_name },
          saved:
            question.permission_offer.saved_in === null
              ? { kind: OFFER_SAVED.unsaved }
              : { kind: OFFER_SAVED.saved, place: question.permission_offer.saved_in }
        },
  contract_proposal: part(question.contract_proposal),
  source_title: part(
    question.source_title === undefined ? undefined : { title: question.source_title }
  ),
  continuity: part(
    question.continuity_revision === null ? null : { revision: question.continuity_revision }
  ),
  created_at: question.created_at,
  timer: part(question.timer)
})

export const wireRunQuestionList = (list: StoredRunQuestionList): RunQuestionList => ({
  questions: list.questions.map(wireRunQuestion),
  next: list.next
})

export const storedAnswerSaid = (
  choices: ReadonlyArray<{ readonly id: string; readonly label: string }>,
  answer: StoredRunQuestionAnswer
): AnswerSaid | undefined => answerSaid(choices, wireRunQuestionAnswer(answer))

export const storedAnswerWords = (
  choices: ReadonlyArray<{ readonly id: string; readonly label: string }>,
  answer: StoredRunQuestionAnswer
): string | undefined => {
  const said = storedAnswerSaid(choices, answer)
  return said === undefined ? undefined : answerWords(said)
}
