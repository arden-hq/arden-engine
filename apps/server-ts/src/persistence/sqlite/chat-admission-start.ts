import { type RunContext } from "../runs/stored-context.js"
import { INTERACTION_KIND, INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { AUTOMATION_CONTEXT_MODE } from "@arden-hq/protocol/automations"
import { RUN_ORIGIN } from "@arden-hq/protocol/runs"
import { SESSION_TYPE } from "@arden-hq/protocol/sessions"
import { RUN_DELIVERY_KIND } from "../deliveries/model.js"
import { type ChatWriteReceiveResult } from "../chat/store.js"
import { runCauses } from "../transcript/run-causes.js"
import { AutomationId } from "../automations/model.js"
import { feedsActivityTriggers } from "../automations/triggers.js"
import { JsonObjectSchema } from "../json.js"
import { setCheckpoint } from "./chat-run.js"
import { appendMessagesInTransaction, contextError, loadActiveMessages } from "./chat-transcript.js"
import { replaceActiveContext } from "./active-context.js"
import { writeError } from "./chat-write-errors.js"
import { appendChatEventsBeforeTurn } from "./chat-events.js"
import { decodeJson } from "./json.js"
import { bindHandlerItem } from "./automation-handler-item.js"
import {
  captureScheduledContext,
  continuedContext,
  recordChildAttempt,
  withCausedBelongsTo,
  wokenOccurrence
} from "./run-context.js"
import { bindInChatTask } from "./in-chat-task.js"
import { taskStepDepth } from "./run-cause.js"
import { captureRunPolicy, workerScopes } from "./run-policy.js"
import { appendQuestionChange } from "./question-events.js"
import { readAgentSessionMetadata } from "../../sessions/agent-mode.js"
import {
  admissionAuthority,
  handedPolicy,
  HANDOFF_SENDER,
  handoffSender,
  spawnerRun
} from "./run-authority.js"
import { nextId } from "./deps.js"
import { AGENT_MESSAGE_TOOL } from "../tools/tool-roles.js"
import { userChatSql } from "./chat-ownership.js"
import { insertChatKey } from "./chat-key-message.js"
import { assistantTextStart } from "./assistant-text-start.js"
import {
  type AdmissionContext,
  type AdmissionDeps,
  transcriptChanged
} from "./chat-admission-context.js"
import { type GateValues } from "./chat-admission-gate.js"
import { type MessageValues } from "./chat-admission-message.js"

export const admissionStart = Effect.fn("SqliteChatWriteStore.admissionStart")(function* (
  input: AdmissionContext & AdmissionDeps & GateValues & MessageValues
) {
  const {
    key,
    valid,
    conflict,
    journalCapture,
    automationRun,
    approvalMode,
    runMetadata,
    sql,
    chatEvents,
    sessionEvents,
    rules,
    automationTokenLimit,
    now,
    timestamp,
    settleDelivery,
    session,
    scheduling,
    arrivalConflict,
    delivery,
    agentResult,
    acceptedMessage,
    requestedModel,
    questionAnswer,
    interactionSender,
    model
  } = input
  const runId = yield* nextId
  if (requestedModel === undefined && session.chat_model === null && model.modelId !== null) {
    yield* sql`
          UPDATE sessions
          SET chat_model = ${model.modelId}
          WHERE session_id = ${valid.sessionId} AND chat_model IS NULL
        `
  }
  if (valid.automationContextMode !== AUTOMATION_CONTEXT_MODE.fresh) {
    yield* appendChatEventsBeforeTurn(sql, { sessionId: valid.sessionId, now })
  }
  const accepted = yield* appendMessagesInTransaction(
    sql,
    valid.sessionId,
    [acceptedMessage],
    timestamp,
    "start",
    acceptedMessage.message_id
  )
  if (valid.automationContextMode === AUTOMATION_CONTEXT_MODE.fresh) {
    yield* replaceActiveContext(sql, valid.sessionId, accepted).pipe(
      Effect.mapError(contextError("start", valid.sessionId))
    )
  }
  const projection =
    valid.automationContextMode === AUTOMATION_CONTEXT_MODE.fresh
      ? accepted
      : yield* loadActiveMessages(sql, valid.sessionId, "start")
  const agent =
    session.session_type === SESSION_TYPE.agent
      ? readAgentSessionMetadata(yield* decodeJson(JsonObjectSchema, session.metadata ?? "{}"))
      : null
  if (session.session_type === SESSION_TYPE.agent && agent === null) {
    return yield* writeError("start", "invalid", "Worker metadata is missing or invalid", {
      sessionId: valid.sessionId
    })
  }
  const previousRuns =
    agent !== null && delivery?.kind !== RUN_DELIVERY_KIND.answer
      ? yield* sql<{
          readonly run_id: string
          readonly context: string
        }>`SELECT run_id, json_extract(metadata_json, '$.run_context') AS context FROM chat_runs WHERE session_id = ${valid.sessionId} ORDER BY started_at DESC, run_id DESC LIMIT 1`
      : []
  const previousRun = previousRuns[0]
  const occurrence =
    valid.automation ??
    (delivery?.kind === RUN_DELIVERY_KIND.result && agent === null
      ? yield* wokenOccurrence({
          sql,
          sessionId: valid.sessionId,
          sourceRunId: delivery.runIds[0],
          now: timestamp
        }).pipe(Effect.mapError(arrivalConflict))
      : undefined)
  const answeredByUser =
    delivery?.kind === RUN_DELIVERY_KIND.answer && delivery.timeout !== true && agent === null
  const sender =
    occurrence === undefined && delivery === undefined
      ? yield* handoffSender(sql, interactionSender, valid.sessionId)
      : undefined
  const handed =
    sender?.kind === HANDOFF_SENDER.delegation &&
    sender.tool === AGENT_MESSAGE_TOOL &&
    agent !== null
      ? undefined
      : sender
  const chatOrigin = {
    kind: "chat",
    session_id: valid.sessionId,
    turn_id: acceptedMessage.message_id
  } as const
  let runContext: RunContext
  if (sender?.kind === HANDOFF_SENDER.continuation) runContext = sender.context
  else if (answeredByUser) runContext = { origin: chatOrigin, task: delivery.context.task }
  else if (delivery?.kind === RUN_DELIVERY_KIND.answer) runContext = delivery.context
  else if (valid.continuesTask !== undefined) {
    const depth = yield* taskStepDepth(sql, valid.continuesTask)
    runContext = {
      origin: depth === 0 ? chatOrigin : { ...chatOrigin, chain_depth: depth },
      task: yield* bindInChatTask(sql, {
        itemId: valid.continuesTask.itemId,
        sessionId: valid.sessionId
      }).pipe(Effect.mapError((cause) => conflict(cause.message, "task_idle")))
    }
  } else if (previousRun)
    runContext = yield* continuedContext(sql, previousRun.context).pipe(
      Effect.mapError(arrivalConflict)
    )
  else if (occurrence === undefined) runContext = { origin: chatOrigin, task: null }
  else {
    runContext = yield* captureScheduledContext({
      sql,
      automationId: occurrence.automationId,
      attemptId: occurrence.attemptId
    }).pipe(
      Effect.mapError((cause) =>
        writeError("start", "invalid", cause.message, { sessionId: valid.sessionId, cause })
      )
    )
  }
  runContext = yield* withCausedBelongsTo(sql, runContext, {
    sessionId: valid.sessionId,
    causingRunId: delivery?.kind === RUN_DELIVERY_KIND.update ? undefined : delivery?.runIds[0],
    sender: interactionSender
  }).pipe(Effect.mapError(arrivalConflict))
  const scheduledPreviousRuns =
    occurrence === undefined
      ? []
      : yield* sql<{ readonly run_id: string }>`SELECT run_id FROM chat_runs
          WHERE session_id = ${valid.sessionId}
            AND json_extract(metadata_json, '$.run_context.origin') = ${JSON.stringify(runContext.origin)}
          ORDER BY started_at DESC, run_id DESC LIMIT 1`
  const previousRunId =
    delivery?.kind === RUN_DELIVERY_KIND.answer && !answeredByUser
      ? delivery.runIds[0]
      : (previousRun?.run_id ?? scheduledPreviousRuns[0]?.run_id)
  const ownPolicy =
    sender?.kind === HANDOFF_SENDER.continuation
      ? sender.policy
      : yield* captureRunPolicy(sql, {
          runId,
          sessionId: valid.sessionId,
          spaceId: session.space_id,
          mode:
            occurrence !== undefined ||
            agent !== null ||
            sender?.kind === HANDOFF_SENDER.delegation ||
            (delivery?.kind === RUN_DELIVERY_KIND.answer &&
              runContext.origin.kind !== RUN_ORIGIN.chat)
              ? "worker"
              : "inline",
          approvalMode,
          ...(occurrence === undefined
            ? {}
            : {
                automationId: occurrence.automationId,
                automationAttemptId: occurrence.attemptId,
                automationCapabilities: rules.automationCapabilities(
                  AutomationId.make(occurrence.automationId)
                ),
                ...(automationTokenLimit === undefined ? {} : { automationTokenLimit })
              }),
          previousRunId,
          sharesRunId: agent === null ? previousRunId : yield* spawnerRun(sql, valid.sessionId),
          taskItemId: runContext.task?.item_id,
          ...(agent === null ? {} : { workerScope: workerScopes[agent.mode] })
        }).pipe(
          Effect.mapError((cause) =>
            writeError("start", "invalid", cause.message, {
              sessionId: valid.sessionId,
              cause
            })
          )
        )
  const runPolicy = handedPolicy(ownPolicy, handed)
  if (valid.message.role !== ROLE.interaction && valid.automation === undefined && agent === null) {
    yield* sql`UPDATE sessions SET metadata = json_set(COALESCE(metadata, '{}'), '$.approval_mode', ${approvalMode})
          WHERE session_id = ${valid.sessionId} AND ${userChatSql()}
            AND json_type(metadata, '$.approval_mode') IS NULL`
  }
  const authority = yield* admissionAuthority(sql, {
    sessionId: valid.sessionId,
    chatAutomationId: session.origin_automation_id,
    context: runContext,
    policy: runPolicy,
    agent,
    ...(handed === undefined ? {} : { source: { kind: handed.kind, runId: handed.runId } })
  })
  yield* sql`
        INSERT INTO chat_runs (
          run_id, session_id, status, started_at, updated_at, metadata_json, client_id,
          assistant_message_id, model_id, reasoning_effort, authority_json
        ) VALUES (
          ${runId}, ${valid.sessionId}, 'running', ${timestamp}, ${timestamp},
          json_set(${runMetadata}, '$.run_context', json(${JSON.stringify(runContext)}), '$.run_policy', json(${JSON.stringify(runPolicy)})), ${valid.clientId},
          ${valid.assistantMessageId}, ${model.modelId}, ${model.reasoningEffort}, ${JSON.stringify(authority)}
        )
      `
  yield* insertChatKey(sql, { ...key, runId, status: "running" })

  if (valid.automation !== undefined) {
    if (valid.automationLease !== undefined) {
      if (valid.automationPrompt === undefined)
        return yield* writeError("start", "invalid", "Handler input requires its captured prompt")
      yield* bindHandlerItem(sql, {
        lease: valid.automationLease,
        ...(valid.handlerItem === undefined ? {} : { item: valid.handlerItem }),
        runId,
        sessionId: valid.sessionId,
        clientId: valid.clientId,
        name: valid.automation.name,
        prompt: valid.automationPrompt,
        itemPrompt: rules.handlerItemPrompt
      }).pipe(
        Effect.mapError((cause) =>
          writeError("start", "invalid", cause.message, {
            sessionId: valid.sessionId,
            cause
          })
        )
      )
    }
    yield* sql`UPDATE automation_runs
          SET chat_run_id = ${runId}, chat_session_id = ${valid.sessionId}
          WHERE id = ${valid.automation.attemptId} AND chat_run_id IS NULL`
  }

  yield* settleDelivery({ kind: "run", runId })

  if (
    agent !== null ||
    (delivery?.kind === RUN_DELIVERY_KIND.answer && runContext.origin.kind !== RUN_ORIGIN.chat)
  ) {
    yield* recordChildAttempt({
      sql,
      runId,
      sessionId: valid.sessionId,
      context: runContext,
      now: timestamp
    }).pipe(
      Effect.mapError((cause) =>
        writeError("start", "storage", cause.message, { sessionId: valid.sessionId, cause })
      )
    )
  }

  const committed = yield* chatEvents
    .appendInTransaction({
      sessionId: valid.sessionId,
      events: [
        {
          event: {
            type: "RUN_STARTED",
            run_id: runId,
            session_id: valid.sessionId,
            turn_id: acceptedMessage.message_id,
            causes: runCauses({
              questionAnswer,
              agentResult,
              sender: interactionSender,
              content: acceptedMessage.content,
              update: delivery?.kind === RUN_DELIVERY_KIND.update ? delivery.update : undefined,
              automation: automationRun
            })
          } satisfies ChatProjectionEvent,
          runId
        },
        {
          event: assistantTextStart(valid.assistantMessageId),
          runId
        },
        ...(valid.announce === true ||
        delivery?.kind === RUN_DELIVERY_KIND.connection ||
        (interactionSender?.kind === INTERACTION_KIND.message &&
          interactionSender.from.source === INTERACTION_SOURCE.agent)
          ? [{ event: transcriptChanged, runId }]
          : [])
      ]
    })
    .pipe(
      Effect.mapError((cause) =>
        writeError("start", "storage", "Could not commit run start events", {
          sessionId: valid.sessionId,
          runId,
          cause
        })
      )
    )
  yield* setCheckpoint(sql, chatEvents, valid.sessionId, runId, committed.headSequence, "start")
  yield* sessionEvents.appendInTransaction("session_activity", valid.sessionId)
  const personalInput =
    valid.automation === undefined &&
    valid.deliveryId === undefined &&
    agent === null &&
    valid.message.role !== ROLE.interaction &&
    feedsActivityTriggers({
      sessionType: session.session_type,
      originAutomationId: session.origin_automation_id
    })
  if (personalInput) {
    yield* sessionEvents.appendEventInTransaction({
      type: "chat_input_committed",
      chat_session_id: valid.sessionId,
      run_id: runId
    })
  }
  if (delivery?.kind !== RUN_DELIVERY_KIND.update && delivery?.questionId) {
    yield* appendQuestionChange({ sql, sessionEvents, questionId: delivery.questionId })
  }
  yield* journalCapture
  return {
    _tag: "Started",
    runId,
    model: model.modelId,
    reasoningEffort: model.reasoningEffort,
    approvalMode,
    outputSchema: valid.outputSchema ?? null,
    automation: valid.automation ?? null,
    automationContextMode: valid.automationContextMode ?? null,
    turnId: valid.message.message_id,
    activeMessages: projection,
    committed,
    scheduling
  } satisfies ChatWriteReceiveResult
})
