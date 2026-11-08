import {
  RunQuestionContentSchema,
  ResolveRunQuestionInputSchema
} from "@arden-hq/protocol/effect/runs"
import { DateTime, Effect, Schema } from "effect"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { WorkStore, WorkStoreError } from "../work/store.js"
import { makeRunQuestionReader } from "./run-question-read.js"
import { workError } from "./work-records.js"
import { assertRunTaskAuthority } from "./run-task-authority.js"
import { enqueueRunDelivery } from "./work-deliveries.js"
import { holdQuestionTask } from "./work-holds.js"
import { readOpenTaskQuestionIds } from "./question-events.js"
import { journalAskChange } from "./ask-changes.js"
import { makeEnsureSpaceConversation } from "./space-conversation.js"
import { matchesRecordedFocusTarget, recordFocusChoiceInTransaction } from "./focus-choices.js"
import { offerAnswerMisfit, recordPermissionOfferInTransaction } from "./permission-offers.js"
import {
  contractAnswerMisfit,
  isContractProposal,
  recordContractProposalInTransaction
} from "./task-contract.js"
import { answerQuestionInTransaction, closeQuestionInTransaction } from "./question-settle.js"
import type { Writer } from "./deps.js"
import { runMayActSql } from "./run-liveness.js"
import { stoppedRunSql } from "./status-sets.js"
import { decodeJson } from "./json.js"
import { answerMisfit, questionAnswerBody } from "./question-answer.js"
import { focusOpenLabel, type FocusChoiceTarget } from "@arden-hq/protocol/sessions/focus-choices"
import type { RunQuestionContent } from "@arden-hq/protocol/runs"
import { sha256Hex } from "@arden-hq/std/hash"

const focusChoices = [
  { id: "continue_here", label: "Continue here" },
  { id: "open_target", label: "Open target" }
] as const

const namedFocusChoices = (target: FocusChoiceTarget) =>
  focusChoices.map((choice) =>
    choice.id === "open_target" ? { ...choice, label: focusOpenLabel(target) } : choice
  )

const sameAsked = (
  recorded: string,
  asked: RunQuestionContent,
  focus: boolean
): Effect.Effect<boolean, WorkStoreError> =>
  !focus
    ? Effect.succeed(recorded === JSON.stringify(asked))
    : decodeJson(RunQuestionContentSchema, recorded).pipe(
        Effect.map(
          (prior) => JSON.stringify({ ...prior, choices: focusChoices }) === JSON.stringify(asked)
        ),
        Effect.mapError((cause) => workError("storage", "Stored Run question is corrupt", cause))
      )

const runQuestionId = (runId: string, toolCallId: string): string =>
  `question:${sha256Hex(JSON.stringify([runId, toolCallId]))}`

export const makeWorkQuestionSql = (options: {
  readonly writer: Writer
  readonly sessionEvents: SessionLifecycleEvents["Service"]
}) => {
  const { writer, sessionEvents } = options
  const sql = writer.sql
  const { get, questions } = makeRunQuestionReader(sql)
  const ensureSpaceConversation = makeEnsureSpaceConversation({
    writer,
    sessionEvents
  })

  const ensureQuestionDestination = Effect.fn("RunQuestion.ensureDestination")(function* (
    runId: string
  ): Effect.fn.Return<void, WorkStoreError> {
    const rows = yield* sql<{ readonly space_id: string | null }>`
      SELECT CASE json_extract(run.metadata_json, '$.run_context.origin.kind')
        WHEN 'task' THEN (
          SELECT task.space_id FROM space_tasks AS task
          WHERE task.item_id = json_extract(run.metadata_json, '$.run_context.origin.item_id')
        )
        WHEN 'space' THEN json_extract(run.metadata_json, '$.run_context.origin.space_id')
        ELSE NULL
      END AS space_id
      FROM chat_runs AS run
      WHERE run.run_id = ${runId} AND ${runMayActSql(sql, "run")}
    `.pipe(
      Effect.mapError((cause) =>
        workError("storage", "Could not resolve the question destination", cause)
      )
    )
    const spaceId = rows[0]?.space_id
    if (spaceId === null || spaceId === undefined) return
    yield* ensureSpaceConversation(spaceId).pipe(
      Effect.mapError((cause) =>
        workError(
          cause.reason === "not_found" ? "invalid" : "storage",
          "Could not prepare the Space question destination",
          cause
        )
      )
    )
  })

  const journalQuestionChange = (questionId: string) =>
    journalAskChange(sql, sessionEvents, { kind: "question_changed", questionId }).pipe(
      Effect.flatMap((appended) =>
        appended
          ? Effect.void
          : Effect.fail(workError("storage", "Could not find the question change owner"))
      ),
      Effect.mapError((cause) =>
        cause instanceof WorkStoreError
          ? cause
          : workError("storage", "Could not announce the question change", cause)
      )
    )

  const askQuestion: WorkStore["Service"]["askQuestion"] = Effect.fn(function* (request) {
    const contentInput =
      request.focusTarget === undefined
        ? request.content
        : { ...request.content, choices: focusChoices }
    const content = yield* Schema.decodeUnknownEffect(RunQuestionContentSchema)(contentInput, {
      onExcessProperty: "error"
    }).pipe(Effect.mapError((cause) => workError("invalid", "Invalid Run question", cause)))
    if (
      request.reuseOpenTaskQuestion &&
      (request.timeout !== undefined ||
        request.focusTarget !== undefined ||
        request.permissionOffer !== undefined ||
        request.contractProposal !== undefined)
    )
      return yield* workError(
        "invalid",
        "A Task wait cannot replace a question with a timer, Focus choice, or permission offer"
      )
    yield* ensureQuestionDestination(request.runId)
    const questionId = runQuestionId(request.runId, request.toolCallId)
    const instant = yield* DateTime.now
    const now = DateTime.formatIso(instant)
    const timeout =
      request.timeout === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              seconds: Schema.Int.check(
                Schema.isGreaterThan(0),
                Schema.isLessThanOrEqualTo(2147483)
              ),
              fallbackChoiceId: Schema.NonEmptyString
            })
          )(request.timeout).pipe(
            Effect.mapError((cause) => workError("invalid", "Invalid question timer", cause))
          )
    if (
      timeout !== undefined &&
      (request.permissionOffer !== undefined ||
        request.contractProposal !== undefined ||
        request.focusTarget !== undefined ||
        content.multiple === true ||
        content.choices[0]?.id !== timeout.fallbackChoiceId)
    )
      return yield* workError(
        "invalid",
        "A timer requires an ordinary single-choice question and its first choice as fallback"
      )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const prior = yield* sql<{
            readonly content: string
            readonly target_json: string | null
            readonly seconds: number | null
            readonly fallback_choice_id: string | null
          }>`SELECT question.content, choice.target_json, timer.seconds, timer.fallback_choice_id
        FROM run_questions AS question
        LEFT JOIN focus_choices AS choice ON choice.question_id = question.question_id
        LEFT JOIN run_question_timers AS timer ON timer.question_id = question.question_id
        WHERE question.question_id = ${questionId}`
          if (prior[0]) {
            const sameTarget = yield* matchesRecordedFocusTarget(
              prior[0].target_json,
              request.focusTarget
            )
            const sameContent = yield* sameAsked(
              prior[0].content,
              content,
              request.focusTarget !== undefined
            )
            if (
              !sameContent ||
              !sameTarget ||
              (prior[0].seconds ?? undefined) !== timeout?.seconds ||
              (prior[0].fallback_choice_id ?? undefined) !== timeout?.fallbackChoiceId
            ) {
              return yield* workError("conflict", "This call already recorded a different question")
            }
            return yield* get(questionId)
          }
          const taskItemId = yield* assertRunTaskAuthority(sql, request.runId)
          if (request.reuseOpenTaskQuestion && taskItemId !== undefined) {
            const pending = yield* readOpenTaskQuestionIds(sql, taskItemId)
            if (pending[0] !== undefined) return yield* get(pending[0])
          }
          yield* sql`INSERT INTO run_questions (question_id, run_id, tool_call_id, content, created_at)
            VALUES (${questionId}, ${request.runId}, ${request.toolCallId}, ${JSON.stringify(content)}, ${now})`
          if (timeout !== undefined) {
            const expiresAt = DateTime.formatIso(
              DateTime.add(instant, { seconds: timeout.seconds })
            )
            yield* sql`INSERT INTO run_question_timers (question_id, expires_at, seconds, fallback_choice_id)
              VALUES (${questionId}, ${expiresAt}, ${timeout.seconds}, ${timeout.fallbackChoiceId})`
          }
          if (request.permissionOffer !== undefined)
            yield* recordPermissionOfferInTransaction({
              sql,
              questionId,
              runId: request.runId,
              offer: request.permissionOffer,
              now
            })
          if (request.contractProposal !== undefined)
            yield* recordContractProposalInTransaction({
              sql,
              questionId,
              runId: request.runId,
              proposal: request.contractProposal,
              now
            })
          const focusChoice =
            request.focusTarget === undefined
              ? null
              : yield* recordFocusChoiceInTransaction({
                  sql,
                  questionId,
                  runId: request.runId,
                  target: request.focusTarget,
                  now
                })
          if (focusChoice !== null) {
            yield* sql`UPDATE run_questions SET content = ${JSON.stringify({
              ...content,
              choices: namedFocusChoices(focusChoice.target)
            })} WHERE question_id = ${questionId}`
          }
          yield* journalQuestionChange(questionId)
          const question = yield* get(questionId)
          if (question.status !== "open")
            return yield* workError("conflict", "This Task attempt no longer has authority to ask")
          return question
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkStoreError
            ? cause
            : workError("storage", "Could not record Run question", cause)
        )
      )
  })

  const resolveQuestion: WorkStore["Service"]["resolveQuestion"] = Effect.fn(function* (request) {
    const input = yield* Schema.decodeUnknownEffect(ResolveRunQuestionInputSchema)(request.input, {
      onExcessProperty: "error"
    }).pipe(Effect.mapError((cause) => workError("invalid", "Invalid question answer", cause)))
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const question = yield* get(request.questionId)
          if (question.focus_choice !== null) {
            return yield* workError(
              "invalid",
              "Focus questions must be resolved through their Focus choice"
            )
          }
          if (question.resolution) {
            if (
              question.resolution.client_id === input.client_id &&
              JSON.stringify(question.resolution.answer) === JSON.stringify(input.answer)
            ) {
              return question
            }
            return yield* workError("conflict", "This question already has an answer")
          }
          if (question.status !== "open")
            return yield* workError("conflict", "This question is no longer actionable")
          const answer = input.answer
          if (answer.kind === "wait") {
            if (question.timer === undefined || question.permission_offer !== null)
              return yield* workError("invalid", "This question has no timer to stop")
            yield* sql`UPDATE run_question_timers SET status = 'cancelled' WHERE question_id = ${request.questionId} AND status = 'pending'`
            yield* journalQuestionChange(request.questionId)
            return yield* get(request.questionId)
          }
          const proposal = yield* isContractProposal(sql, request.questionId)
          const misfit = (() => {
            if (question.permission_offer !== null) return offerAnswerMisfit(answer)
            if (proposal)
              return contractAnswerMisfit(answer) ?? answerMisfit(question.content, answer)
            return answerMisfit(question.content, answer)
          })()
          if (misfit !== undefined) return yield* workError("invalid", misfit)
          const body = questionAnswerBody(question, answer)
          yield* answerQuestionInTransaction({
            sql,
            questionId: request.questionId,
            clientId: input.client_id,
            answer,
            now
          })
          if (answer.kind === "hold") yield* holdQuestionTask({ sql, sessionEvents, question, now })
          if (body !== undefined) {
            yield* enqueueRunDelivery({
              sql,
              eventId: `question-answer:${question.question_id}`,
              now,
              subject: "Answer to your question",
              body,
              payload: {
                kind: "answer",
                sessionId: question.session_id,
                context: question.context,
                runIds: [question.run_id],
                questionId: question.question_id
              }
            })
          }
          yield* journalQuestionChange(request.questionId)
          return yield* get(request.questionId)
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkStoreError
            ? cause
            : workError("storage", "Could not resolve Run question", cause)
        )
      )
  })

  const expireQuestions: WorkStore["Service"]["expireQuestions"] = Effect.fn("RunQuestion.expire")(
    function* () {
      const now = DateTime.formatIso(yield* DateTime.now)
      yield* writer
        .transact(
          Effect.gen(function* () {
            const due = yield* sql<{
              readonly question_id: string
              readonly stopped: number
            }>`SELECT timer.question_id,
        ${stoppedRunSql("run")} AS stopped
        FROM run_question_timers AS timer JOIN run_questions AS question ON question.question_id = timer.question_id
        JOIN chat_runs AS run ON run.run_id = question.run_id
        WHERE timer.status = 'pending' AND (timer.expires_at <= ${now} OR ${stoppedRunSql("run")})
        ORDER BY timer.expires_at, timer.question_id LIMIT 32`
            for (const row of due) {
              const question = yield* get(row.question_id)
              const timer = question.timer
              if (timer === undefined) continue
              if (question.status !== "open" || row.stopped === 1) {
                yield* sql`UPDATE run_question_timers SET status = 'cancelled' WHERE question_id = ${row.question_id}`
                yield* journalQuestionChange(row.question_id)
                continue
              }
              const fallback = question.content.choices.find(
                (choice) => choice.id === timer.fallback_choice_id
              )
              if (
                fallback === undefined ||
                question.permission_offer !== null ||
                question.focus_choice !== null
              )
                return yield* workError("storage", "Timed question has no ordinary fallback")
              yield* closeQuestionInTransaction({
                sql,
                questionId: row.question_id,
                timer: "elapsed",
                now
              })
              yield* enqueueRunDelivery({
                sql,
                eventId: `question-timeout:${row.question_id}`,
                now,
                subject: "Question timer elapsed",
                body: `<question_timeout>${JSON.stringify({
                  question_id: question.question_id,
                  prompt: question.content.prompt,
                  fallback: fallback.label,
                  instruction:
                    "The user did not answer. Continue with this previously declared fallback within your existing authority. Silence grants no approval or permission."
                })}</question_timeout>`,
                payload: {
                  kind: "answer",
                  timeout: true,
                  sessionId: question.session_id,
                  context: question.context,
                  runIds: [question.run_id],
                  questionId: question.question_id
                }
              })
              yield* journalQuestionChange(row.question_id)
            }
          })
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof WorkStoreError
              ? cause
              : workError("storage", "Could not expire question timers", cause)
          )
        )
    }
  )

  return { askQuestion, resolveQuestion, questions, expireQuestions }
}
