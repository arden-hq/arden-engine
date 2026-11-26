import { CHAT_WRITE_FAILURE } from "../chat/store.js"
import { RUN_DELIVERY_KIND } from "../deliveries/model.js"
import { INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
import { agentResultPresentation } from "./agent-result-presentation.js"
import { DateTime, Effect, Option, Schema } from "effect"
import { QuestionAnswerSchema } from "@arden-hq/protocol/effect/chat"
import { CHAT_WRITE_STORED, type ChatWriteReceiveResult } from "../chat/store.js"
import { senderOf } from "../transcript/interaction.js"
import { StoredMessageEnvelopeSchema, isWrittenByPerson } from "../transcript/model.js"
import { dropPendingArchive } from "./pending-archive.js"
import { appendMessagesInTransaction } from "./chat-transcript.js"
import { writeError } from "./chat-write-errors.js"
import { encodeJson } from "./json.js"
import { readModelSelection, readRequestedModel, runInheritsChatModel } from "./models.js"
import { holdsUnattendedInput, readLastEndedRun } from "./chat-hold.js"
import { appendQuestionChange } from "./question-events.js"
import { settleTypedReply } from "./typed-reply.js"
import { handoffSender } from "./run-authority.js"
import { latestVisibleActivityMs } from "./idle-gap.js"
import {
  foregroundRunStatusList,
  unresolvedToolStatusList,
  waitingToolStatusList
} from "./status-sets.js"
import { insertChatKey } from "./chat-key-message.js"
import {
  type AdmissionContext,
  type AdmissionDeps,
  transcriptChanged
} from "./chat-admission-context.js"
import { type GateValues } from "./chat-admission-gate.js"

export const admissionMessage = Effect.fn("SqliteChatWriteStore.admissionMessage")(function* (
  input: AdmissionContext & AdmissionDeps & GateValues
) {
  const {
    valid,
    conflict,
    journalCapture,
    runtime,
    sql,
    chatEvents,
    sessionEvents,
    rules,
    now,
    timestamp,
    settleDelivery,
    session,
    delivery
  } = input
  yield* settleTypedReply({ sql, sessionEvents, chatEvents, input: valid, now: timestamp })

  const priorActivityMs =
    valid.message.role === ROLE.interaction
      ? null
      : yield* latestVisibleActivityMs({ sql, sessionId: valid.sessionId })
  const agentResult =
    delivery?.kind === RUN_DELIVERY_KIND.result
      ? yield* agentResultPresentation(sql, valid.sessionId, valid.clientId)
      : undefined
  const acceptedMessage = rules.acceptMessage({
    message:
      agentResult === undefined ? valid.message : { ...valid.message, agent_result: agentResult },
    elapsedMs: priorActivityMs === null ? null : DateTime.toEpochMillis(now) - priorActivityMs
  })
  const messageJson = yield* encodeJson(StoredMessageEnvelopeSchema, acceptedMessage).pipe(
    Effect.mapError((cause) =>
      writeError("start", "invalid", "User message cannot be encoded", {
        sessionId: valid.sessionId,
        cause
      })
    )
  )
  const key = {
    sessionId: valid.sessionId,
    clientId: valid.clientId,
    requestHash: valid.requestHash,
    messageId: acceptedMessage.message_id,
    messageJson,
    at: timestamp
  }

  const requestedModel = yield* Effect.gen(function* () {
    if (runInheritsChatModel(valid.automationContextMode, session.chat_model)) return undefined
    if (valid.modelId !== undefined)
      return yield* readRequestedModel(sql, runtime, { modelId: valid.modelId })
    if (valid.modelRole !== undefined)
      return yield* readRequestedModel(sql, runtime, { modelRole: valid.modelRole })
    return undefined
  }).pipe(
    Effect.mapError((cause) =>
      writeError(
        "start",
        cause.reason === CHAT_WRITE_FAILURE.storage
          ? CHAT_WRITE_FAILURE.storage
          : CHAT_WRITE_FAILURE.invalid,
        cause.message,
        {
          sessionId: valid.sessionId,
          cause
        }
      )
    )
  )
  const questionAnswer = Option.getOrUndefined(
    Schema.decodeUnknownOption(QuestionAnswerSchema)(acceptedMessage.question_answer)
  )
  const interactionSender = senderOf(acceptedMessage)
  if (valid.automation === undefined && isWrittenByPerson(acceptedMessage))
    yield* dropPendingArchive(sql, valid.sessionId)
  const activeRuns = yield* sql<{
    readonly run_id: string
    readonly model_id: string | null
    readonly reasoning_effort: string | null
    readonly automation_task_id: string | null
  }>`
        SELECT run_id, model_id, reasoning_effort,
          json_extract(metadata_json, '$.automation.task_id') AS automation_task_id
        FROM chat_runs
        WHERE session_id = ${valid.sessionId}
          AND status IN ${foregroundRunStatusList}
        ORDER BY updated_at DESC, started_at DESC, run_id DESC
        LIMIT 1
      `
  const activeRun = activeRuns[0]
  if (activeRun !== undefined) {
    if (valid.fromQueue === true) return yield* conflict("The Chat is running", "session_busy")
    if (valid.automation !== undefined) {
      return yield* conflict("The attached Chat is already running", "session_busy")
    }
    if (
      requestedModel !== undefined &&
      (activeRun.model_id !== requestedModel.modelId ||
        activeRun.reasoning_effort !== requestedModel.reasoningEffort)
    ) {
      return yield* conflict("The active Chat run uses a different model than the requested role")
    }
    if (valid.continuesTask !== undefined) {
      return yield* conflict("The Task continues when the current Chat turn ends", "session_busy")
    }
    if (delivery?.kind === RUN_DELIVERY_KIND.answer && delivery.runIds[0] !== activeRun.run_id) {
      return yield* conflict("Arrival waits for the current Chat turn")
    }
    yield* insertChatKey(sql, { ...key, runId: activeRun.run_id, status: "queued" })
    yield* settleDelivery({ kind: "run", runId: activeRun.run_id })
    if (delivery?.kind !== RUN_DELIVERY_KIND.update && delivery?.questionId) {
      yield* appendQuestionChange({ sql, sessionEvents, questionId: delivery.questionId })
    }
    yield* journalCapture
    return {
      done: {
        _tag: "Queued",
        runId: activeRun.run_id
      } satisfies ChatWriteReceiveResult
    }
  }

  const model =
    valid.wake === false
      ? undefined
      : (requestedModel ??
        (yield* readModelSelection(sql, runtime, valid.sessionId).pipe(
          Effect.mapError((cause) =>
            writeError(
              "start",
              cause.reason === CHAT_WRITE_FAILURE.storage
                ? CHAT_WRITE_FAILURE.storage
                : CHAT_WRITE_FAILURE.invalid,
              cause.message,
              {
                sessionId: valid.sessionId,
                cause
              }
            )
          )
        )))
  const held =
    model !== undefined &&
    valid.message.role === ROLE.interaction &&
    valid.opensOnboarding !== true &&
    valid.automation === undefined &&
    valid.continuesTask === undefined &&
    delivery?.kind !== RUN_DELIVERY_KIND.answer &&
    holdsUnattendedInput(yield* readLastEndedRun(sql, valid.sessionId), model.modelId)
  if (model === undefined || held) {
    if (!held) {
      if (interactionSender?.from.source !== INTERACTION_SOURCE.agent)
        return yield* conflict("Only an agent message may be stored without waking")
      yield* handoffSender(sql, interactionSender, valid.sessionId)
    }
    yield* appendMessagesInTransaction(
      sql,
      valid.sessionId,
      [acceptedMessage],
      timestamp,
      "start",
      acceptedMessage.message_id
    )
    yield* insertChatKey(sql, { ...key, runId: null, status: "accepted" })
    yield* settleDelivery({ kind: "session", sessionId: valid.sessionId })
    yield* chatEvents.appendInTransaction({
      sessionId: valid.sessionId,
      events: [{ event: transcriptChanged }]
    })
    return { done: { _tag: CHAT_WRITE_STORED.stored } satisfies ChatWriteReceiveResult }
  }

  const unresolvedApprovals = yield* sql<{ readonly tool_call_id: string }>`
        SELECT tool_call_id FROM tool_calls
        WHERE session_id = ${valid.sessionId}
          AND status IN ${unresolvedToolStatusList} AND status IN ${waitingToolStatusList}
        LIMIT 1
      `
  if (unresolvedApprovals.length > 0) {
    return yield* conflict("A tool approval must be resolved before Chat can continue")
  }
  return {
    values: {
      key,
      agentResult,
      acceptedMessage,
      requestedModel,
      questionAnswer,
      interactionSender,
      model
    }
  }
})

export type MessageValues = Extract<
  Effect.Success<ReturnType<typeof admissionMessage>>,
  { readonly values: unknown }
>["values"]
