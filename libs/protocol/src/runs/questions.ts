import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, NonNegativeIntSchema } from "../common/schema.js"
import { RunContextSchema } from "./context.js"

const identity = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1024))
const text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(8000))
export const RunQuestionContentSchema = Schema.Struct({
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
  /** True lets the answer pick several choices. Absent (every question
   *  stored before it) or false: one choice. */
  multiple: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "True when the user may pick more than one choice." })
  )
})

const uniqueIds = Schema.makeFilter((ids: ReadonlyArray<string>) =>
  new Set(ids).size === ids.length ? undefined : "choice ids must be unique"
)

export const RunQuestionAnswerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text }),
  Schema.Struct({ kind: Schema.Literal("choice"), choice_id: identity }),
  /** Several picks on a question marked `multiple`, with the words the user
   *  typed beside them, if any. */
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
  answer: RunQuestionAnswerSchema,
  resolved_at: IsoDateTimeStringSchema
})

export const AnswerWithdrawalReasonSchema = Schema.Literals([
  "execution_allowance_unavailable",
  "destination_deleted",
  "task_changed",
  "space_policy_changed"
])
const continuationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("queued") }),
  /** The asking run was still working: the answer waits in that run for its
   *  next model step. */
  Schema.Struct({ kind: Schema.Literal("steering"), run_id: identity }),
  /** The asking run took the answer in mid-run, at `at`. */
  Schema.Struct({ kind: Schema.Literal("steered"), run_id: identity, at: IsoDateTimeStringSchema }),
  Schema.Struct({ kind: Schema.Literal("started"), run_id: identity, at: IsoDateTimeStringSchema }),
  Schema.Struct({
    kind: Schema.Literal("withdrawn"),
    reason: AnswerWithdrawalReasonSchema,
    at: IsoDateTimeStringSchema
  })
])

export const RunQuestionFocusChoiceSchema = Schema.Struct({
  space_id: identity,
  revision: NonNegativeIntSchema,
  status: Schema.Literals(["offered", "settled"] as const)
})

/** Where an owner's tap saved a permission rule: a Space by name, Arden's own
 *  jobs' list, or everywhere. */
export const RuleSavedInSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("space"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("system") }),
  Schema.Struct({ kind: Schema.Literal("everywhere") })
])
export type RuleSavedIn = typeof RuleSavedInSchema.Type
export const isRuleSavedIn = Schema.is(RuleSavedInSchema)

/** The question offers a lasting permission change: one tool's rule
 *  (`tool_name`), or a connector's, the chat's mode or a command prefix
 *  (null). A choice saves it in that scope, and only the person's own answer
 *  does; `saved_in` says where the rule went once it is saved. */
export const RunQuestionPermissionOfferSchema = Schema.Struct({
  tool_name: Schema.NullOr(identity),
  saved_in: Schema.NullOr(RuleSavedInSchema)
})

/** The question proposes a change to a Task's contract: a line added, one
 *  that replaces a saved line, or a saved line removed. Only the person's
 *  Save keeps it. */
export const RunQuestionContractProposalSchema = Schema.Struct({
  item_id: identity,
  /** The Task's name. */
  task: Schema.String,
  change: Schema.Literals(["add", "replace", "remove"]),
  /** The line it adds, or the line it removes. */
  line: Schema.String
})

export const RunQuestionSchema = Schema.Struct({
  question_id: identity,
  run_id: identity,
  turn_id: identity,
  session_id: identity,
  /** The chat the question is destined to: where its card shows and who reads it. */
  destination_session_id: identity,
  context: RunContextSchema,
  content: RunQuestionContentSchema,
  status: Schema.Literals(["open", "suspended", "closed", "resolved"]),
  resolution: Schema.NullOr(resolutionSchema),
  continuation: Schema.NullOr(continuationSchema),
  focus_choice: Schema.NullOr(RunQuestionFocusChoiceSchema),
  permission_offer: Schema.NullOr(RunQuestionPermissionOfferSchema),
  /** Absent on every question that proposes no contract change. */
  contract_proposal: Schema.optionalKey(RunQuestionContractProposalSchema),
  /** The asking chat's name (a run copy's parent's), for the card's head;
   *  absent when neither has one. */
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
    (question.status === "resolved") === (question.resolution !== null)
      ? undefined
      : "resolved questions must have exactly one resolution"
  )
)

export const RunQuestionListSchema = Schema.Struct({
  questions: Schema.Array(RunQuestionSchema),
  next_cursor: Schema.NullOr(identity)
})
export const RunQuestionListOptionsSchema = Schema.Struct({
  space_id: Schema.optionalKey(identity),
  session_id: Schema.optionalKey(identity),
  item_id: Schema.optionalKey(identity),
  state: Schema.optionalKey(Schema.Literals(["actionable", "all"])),
  cursor: Schema.optionalKey(identity)
})
export const ResolveRunQuestionInputSchema = Schema.Struct({
  client_id: identity,
  answer: Schema.Union([RunQuestionAnswerSchema, Schema.Struct({ kind: Schema.Literal("wait") })])
})

type RunQuestionAnswer = typeof RunQuestionAnswerSchema.Type

/** What an answer says: the labels it chose, in the question's order, and
 *  the words typed with it. Undefined for a hold or a skip, which say
 *  nothing. A choice id the question no longer holds is named by its id. */
export interface AnswerSaid {
  readonly chosen: ReadonlyArray<string>
  readonly typed: string | undefined
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
    case "text":
      return { chosen: [], typed: answer.text.trim() }
    case "choice":
      return { chosen: labelsOf([answer.choice_id]), typed: undefined }
    case "choices":
      return { chosen: labelsOf(answer.choice_ids), typed: answer.text?.trim() || undefined }
    case "hold":
    case "dismiss":
      return undefined
  }
}

/** The answer as one line: the chosen labels, then what was typed. */
export const answerWords = (said: AnswerSaid): string =>
  [said.chosen.join(", "), said.typed ?? ""].filter((part) => part.length > 0).join("; ")

export type RunQuestion = typeof RunQuestionSchema.Type
export type RunQuestionContent = typeof RunQuestionContentSchema.Type
export type RunQuestionList = typeof RunQuestionListSchema.Type
export type RunQuestionListOptions = typeof RunQuestionListOptionsSchema.Type
export type ResolveRunQuestionInput = typeof ResolveRunQuestionInputSchema.Type

export const encodeResolveRunQuestionEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ResolveRunQuestionInputSchema)(value, {
    onExcessProperty: "error"
  }).pipe(Effect.map(JSON.stringify))

/** Only resolved questions leave a transcript row that advances the seen cursor.
 * Open questions live in the dock; closed and suspended questions leave no row. */
export const settledQuestionDrawn = (
  question: Pick<typeof RunQuestionSchema.Type, "status">
): boolean => question.status === "resolved"
