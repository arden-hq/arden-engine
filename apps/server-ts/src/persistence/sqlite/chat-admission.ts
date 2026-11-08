import { readDefaultApprovalMode } from "./default-approval-mode.js"
import { agentResultPresentation } from "./agent-result-presentation.js"
import { DateTime, Effect, Option, Schema } from "effect"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import type { RunContext } from "@arden-hq/protocol/runs"
import { InteractionSchema, QuestionAnswerSchema } from "@arden-hq/protocol/effect/chat"
import {
  ChatWriteConflictError,
  type ChatWriteStore,
  type ChatWriteReceiveInput,
  type ChatWriteReceiveResult,
  type ChatWriteFailure
} from "../chat/store.js"
import type { ModelCatalog } from "../../models/catalog.js"
import type { IntelligenceSettingsStore, LimitSettingsStore } from "../settings/store.js"
import type { ChatRules } from "../chat/rules.js"
import { StoredMessageEnvelopeSchema } from "../transcript/model.js"
import { isHumanMessage } from "../transcript/content.js"
import { dropPendingArchive } from "./pending-archive.js"
import { chatAdmissionInputSchema } from "./chat-admission-input.js"
import { AutomationId } from "../automations/model.js"
import { feedsActivityTriggers } from "../automations/triggers.js"
import { JsonObjectSchema } from "../json.js"
import { TOOL_PERSISTENCE_FAILED } from "../tools/store.js"
import { WorkStoreError } from "../work/store.js"
import { loadRun, setCheckpoint } from "./chat-run.js"
import { loadLiveSession, schedulingForSession } from "./chat-session.js"
import { appendMessagesInTransaction, contextError, loadActiveMessages } from "./chat-transcript.js"
import { replaceActiveContext } from "./active-context.js"
import { validateInput, writeError, mapFailure } from "./chat-write-errors.js"
import { appendChatEventsBeforeTurn } from "./chat-events.js"
import { loadReceipt } from "./chat-admission-receipt.js"
import { decodeJson, encodeJson } from "./json.js"
import { bindHandlerItem } from "./automation-handler-item.js"
import { assertAutomationLease } from "./automation-lease.js"
import { readModelSelection, readRequestedModel, runInheritsChatModel } from "./models.js"
import { liftOwedUpdate, readDeliveryForAdmission } from "./work-deliveries.js"
import {
  captureScheduledContext,
  continuedContext,
  recordChildAttempt,
  withCausedBelongsTo,
  wokenOccurrence
} from "./run-context.js"
import { bindInChatTask } from "./in-chat-task.js"
import { holdsUnattendedInput, readLastEndedRun } from "./chat-hold.js"
import { captureRunPolicy, workerScopes } from "./run-policy.js"
import { appendQuestionChange } from "./question-events.js"
import { settleTypedReply } from "./typed-reply.js"
import { readAgentSessionMetadata } from "../../sessions/agent-mode.js"
import { admissionAuthority, handedPolicy, handoffSender, spawnerRun } from "./run-authority.js"
import { latestVisibleActivityMs } from "./idle-gap.js"
import {
  foregroundRunStatusList,
  unresolvedToolStatusList,
  waitingToolStatusList
} from "./status-sets.js"
import type { PersistenceDeps } from "./deps.js"
import { transactWithActiveContext } from "./active-context-stage.js"
import { nextId } from "./deps.js"
import { userChatSql } from "./chat-ownership.js"
import { claimQueued } from "./chat-queue.js"

const transcriptChanged = { type: "transcript_changed" } satisfies ChatProjectionEvent

export const makeChatAdmission = ({
  writer,
  chatEvents,
  sessionEvents,
  catalog,
  intelligence,
  limits,
  rules
}: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents"> & {
  readonly catalog: ModelCatalog["Service"]
  readonly intelligence: IntelligenceSettingsStore["Service"]
  readonly limits: LimitSettingsStore["Service"]
  readonly rules: ChatRules["Service"]
}): Pick<ChatWriteStore["Service"], "start" | "receive" | "prepareReceive"> => {
  const sql = writer.sql
  const prepareReceive = Effect.fn("SqliteChatWriteStore.prepareReceive")(function* (
    input: ChatWriteReceiveInput
  ): Effect.fn.Return<Effect.Effect<ChatWriteReceiveResult, ChatWriteFailure>, ChatWriteFailure> {
    const valid = yield* validateInput(chatAdmissionInputSchema, input, "start")
    const conflict = (message: string, kind?: "session_busy" | "task_idle" | "queue_changed") =>
      new ChatWriteConflictError({
        sessionId: valid.sessionId,
        clientId: valid.clientId,
        message,
        ...(kind === undefined ? {} : { kind })
      })
    const capture = valid.capture
    const journalCapture =
      capture === undefined
        ? Effect.void
        : sessionEvents.appendEventInTransaction({
            type: "capture_arrived",
            session_id: valid.sessionId,
            client_id: valid.clientId,
            via: capture.via,
            note: capture.note,
            screenshot: capture.screenshot,
            produced_by: null,
            chain_depth: 0
          })
    const automationRun =
      valid.automation === undefined ||
      valid.automationPrompt === undefined ||
      valid.automationContextMode === undefined
        ? undefined
        : {
            ...valid.automation,
            prompt: valid.automationPrompt,
            contextMode: valid.automationContextMode
          }
    const priorReceipt = yield* loadReceipt(
      sql,
      valid.sessionId,
      valid.clientId,
      valid.requestHash,
      valid.message
    )
    const runtime =
      priorReceipt === null
        ? yield* catalog.runtime().pipe(
            Effect.mapError((cause) =>
              writeError("start", "storage", "Could not load the model catalog", {
                sessionId: valid.sessionId,
                cause
              })
            )
          )
        : null
    const { sessionId } = valid
    const approvalMode =
      valid.approvalMode ??
      (yield* readDefaultApprovalMode(sql).pipe(
        Effect.mapError((cause) =>
          writeError("start", "storage", "No default mode", { sessionId, cause })
        )
      ))
    const runMetadata = yield* encodeJson(JsonObjectSchema, {
      turn_id: valid.message.message_id,
      ...(valid.outputSchema === undefined ? {} : { output_schema: valid.outputSchema }),
      ...(automationRun === undefined
        ? {}
        : {
            automation: {
              task_id: automationRun.automationId,
              name: automationRun.name,
              prompt: automationRun.prompt,
              context_mode: automationRun.contextMode
            }
          })
    }).pipe(
      Effect.mapError((cause) =>
        writeError("start", "invalid", "Chat run metadata cannot be encoded", {
          sessionId: valid.sessionId,
          cause
        })
      )
    )

    return transactWithActiveContext(
      writer,
      "interactive",
      { sessionId: valid.sessionId },
      Effect.gen(function* () {
        const controls = yield* intelligence.settings().pipe(
          Effect.mapError((cause) =>
            writeError("start", "storage", "Could not read agent settings", {
              sessionId: valid.sessionId,
              cause
            })
          )
        )
        const automationTokenLimit =
          valid.automation === undefined
            ? undefined
            : ((yield* limits.settings().pipe(
                Effect.mapError((cause) =>
                  writeError("start", "storage", "Could not read the plan limits", {
                    sessionId: valid.sessionId,
                    cause
                  })
                )
              )).automationLimits[valid.automation.automationId]?.maxTokensPerRun ?? undefined)
        const now = yield* DateTime.now
        const timestamp = DateTime.formatIso(now)
        const session = yield* loadLiveSession(sql, valid.sessionId)
        const preparing = yield* sql<{ readonly child_session_id: string }>`
            SELECT child_session_id FROM session_fork_requests
            WHERE child_session_id = ${valid.sessionId} AND state = 'preparing'
          `
        if (preparing.length !== 0) {
          return yield* conflict(
            "The chat fork is still preparing its files. Retry the fork before sending."
          )
        }
        if (valid.automation && valid.automationLease) {
          yield* assertAutomationLease(sql, {
            lease: valid.automationLease,
            ...valid.automation,
            sessionId: valid.sessionId
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof WorkStoreError
                ? conflict(cause.message)
                : writeError("start", "storage", "Could not inspect Automation lease", {
                    sessionId: valid.sessionId,
                    cause
                  })
            )
          )
        }
        const claimed = yield* claimQueued(sql, {
          sessionId: valid.sessionId,
          clientId: valid.clientId,
          headOnly: valid.fromQueue === true
        })
        const scheduling = yield* schedulingForSession(
          sql,
          session.session_id,
          session.session_type,
          controls.maxConcurrentAgents,
          "start"
        )
        const receipt = yield* loadReceipt(
          sql,
          valid.sessionId,
          valid.clientId,
          valid.requestHash,
          valid.message
        )
        if (receipt === null && valid.fromQueue === true && !claimed)
          return yield* conflict("The queued message is no longer at the head", "queue_changed")
        if (receipt !== null) {
          if (receipt.run_id === null) return { _tag: "Stored" } satisfies ChatWriteReceiveResult
          const existingRun = yield* loadRun(sql, receipt.run_id, "start")
          if (existingRun.session_id !== valid.sessionId) {
            return yield* writeError(
              "start",
              "corrupt",
              "Idempotency receipt points to another run",
              {
                sessionId: valid.sessionId,
                runId: receipt.run_id
              }
            )
          }
          return {
            _tag: "Existing",
            runId: receipt.run_id,
            status: receipt.status
          } satisfies ChatWriteReceiveResult
        }

        if (runtime === null) {
          return yield* conflict("The saved request expired before it could be replayed")
        }

        const arrivalConflict = (cause: { readonly message: string }) => conflict(cause.message)
        const delivery =
          valid.deliveryId === undefined
            ? undefined
            : yield* readDeliveryForAdmission({
                sql,
                deliveryId: valid.deliveryId,
                sessionId: valid.sessionId,
                admittedWith: valid.admittedWith ?? [],
                content: valid.message["content"]
              }).pipe(Effect.mapError(arrivalConflict))
        yield* liftOwedUpdate(sql, sessionEvents, delivery, timestamp)
        const blockedRuns = yield* sql<{ readonly run_id: string }>`
        SELECT run_id FROM chat_runs
        WHERE session_id = ${valid.sessionId}
          AND status = 'error'
          AND error_code = ${TOOL_PERSISTENCE_FAILED}
        LIMIT 1
      `
        if (blockedRuns.length > 0) {
          return yield* conflict(
            "A tool persistence failure must be resolved before Chat can continue"
          )
        }

        yield* settleTypedReply({ sql, sessionEvents, chatEvents, input: valid, now: timestamp })

        const priorActivityMs =
          valid.message.is_meta === true
            ? null
            : yield* latestVisibleActivityMs({ sql, sessionId: valid.sessionId })
        const agentResult =
          delivery?.kind === "result"
            ? yield* agentResultPresentation(sql, valid.sessionId, valid.clientId)
            : undefined
        const acceptedMessage = rules.acceptMessage({
          message:
            agentResult === undefined
              ? valid.message
              : { ...valid.message, agent_result: agentResult },
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

        const requestedModel = yield* Effect.gen(function* () {
          if (runInheritsChatModel(valid.automationContextMode, session.chat_model))
            return undefined
          if (valid.modelId !== undefined)
            return yield* readRequestedModel(sql, runtime, { modelId: valid.modelId })
          if (valid.modelRole !== undefined)
            return yield* readRequestedModel(sql, runtime, { modelRole: valid.modelRole })
          return undefined
        }).pipe(
          Effect.mapError((cause) =>
            writeError("start", cause.reason === "storage" ? "storage" : "invalid", cause.message, {
              sessionId: valid.sessionId,
              cause
            })
          )
        )
        const questionAnswer = Option.getOrUndefined(
          Schema.decodeUnknownOption(QuestionAnswerSchema)(acceptedMessage.question_answer)
        )
        const interaction = Option.getOrUndefined(
          Schema.decodeUnknownOption(InteractionSchema)(acceptedMessage.interaction)
        )
        if (valid.automation === undefined && isHumanMessage(acceptedMessage))
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
          if (valid.fromQueue === true)
            return yield* conflict("The Chat is running", "session_busy")
          if (valid.automation !== undefined) {
            return yield* conflict("The attached Chat is already running", "session_busy")
          }
          if (
            requestedModel !== undefined &&
            (activeRun.model_id !== requestedModel.modelId ||
              activeRun.reasoning_effort !== requestedModel.reasoningEffort)
          ) {
            return yield* conflict(
              "The active Chat run uses a different model than the requested role"
            )
          }
          if (valid.continuesTask !== undefined) {
            return yield* conflict(
              "The Task continues when the current Chat turn ends",
              "session_busy"
            )
          }
          if (delivery?.kind === "answer" && delivery.runIds[0] !== activeRun.run_id) {
            return yield* conflict("Arrival waits for the current Chat turn")
          }
          yield* sql`
          INSERT INTO chat_idempotency_keys (
            session_id, client_id, request_hash, run_id, message_id, message_json, status,
            created_at, updated_at
          ) VALUES (
            ${valid.sessionId}, ${valid.clientId}, ${valid.requestHash}, ${activeRun.run_id},
            ${acceptedMessage.message_id}, ${messageJson}, 'queued', ${timestamp}, ${timestamp}
          )
        `
          if (valid.deliveryId !== undefined) {
            yield* sql`UPDATE automation_deliveries SET status = 'delivered', delivered_at = ${timestamp},
            destinations = ${JSON.stringify([`chat:${activeRun.run_id}`])}
            WHERE delivery_id = ${valid.deliveryId} AND status = 'pending'`
          }
          if (delivery?.kind !== "update" && delivery?.questionId) {
            yield* appendQuestionChange({ sql, sessionEvents, questionId: delivery.questionId })
          }
          yield* journalCapture
          return {
            _tag: "Queued",
            runId: activeRun.run_id
          } satisfies ChatWriteReceiveResult
        }

        const model =
          valid.wake === false
            ? undefined
            : (requestedModel ??
              (yield* readModelSelection(sql, runtime, valid.sessionId).pipe(
                Effect.mapError((cause) =>
                  writeError(
                    "start",
                    cause.reason === "storage" ? "storage" : "invalid",
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
          valid.message.is_meta === true &&
          valid.automation === undefined &&
          valid.continuesTask === undefined &&
          delivery?.kind !== "answer" &&
          holdsUnattendedInput(yield* readLastEndedRun(sql, valid.sessionId), model.modelId)
        if (model === undefined || held) {
          if (!held) {
            if (valid.message.is_meta !== true || interaction?.from.type !== "agent")
              return yield* conflict("Only an agent message may be stored without waking")
            yield* handoffSender(sql, interaction, valid.sessionId)
          }
          yield* appendMessagesInTransaction(
            sql,
            valid.sessionId,
            [acceptedMessage],
            timestamp,
            "start",
            acceptedMessage.message_id
          )
          yield* sql`INSERT INTO chat_idempotency_keys (
              session_id, client_id, request_hash, message_id, message_json, status, created_at, updated_at
            ) VALUES (${valid.sessionId}, ${valid.clientId}, ${valid.requestHash},
              ${acceptedMessage.message_id}, ${messageJson}, 'accepted', ${timestamp}, ${timestamp})`
          if (valid.deliveryId !== undefined) {
            yield* sql`UPDATE automation_deliveries SET status = 'delivered', delivered_at = ${timestamp},
                destinations = ${JSON.stringify([`chat:${valid.sessionId}`])}
                WHERE delivery_id = ${valid.deliveryId} AND status = 'pending'`
          }
          yield* chatEvents.appendInTransaction({
            sessionId: valid.sessionId,
            events: [{ event: transcriptChanged }]
          })
          return { _tag: "Stored" } satisfies ChatWriteReceiveResult
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

        const runId = yield* nextId
        if (requestedModel === undefined && session.chat_model === null && model.modelId !== null) {
          yield* sql`
          UPDATE sessions
          SET chat_model = ${model.modelId}
          WHERE session_id = ${valid.sessionId} AND chat_model IS NULL
        `
        }
        if (valid.automationContextMode !== "fresh") {
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
        if (valid.automationContextMode === "fresh") {
          yield* replaceActiveContext(sql, valid.sessionId, accepted).pipe(
            Effect.mapError(contextError("start", valid.sessionId))
          )
        }
        const projection =
          valid.automationContextMode === "fresh"
            ? accepted
            : yield* loadActiveMessages(sql, valid.sessionId, "start")
        const agent =
          session.session_type === "agent"
            ? readAgentSessionMetadata(
                yield* decodeJson(JsonObjectSchema, session.metadata ?? "{}")
              )
            : null
        if (session.session_type === "agent" && agent === null) {
          return yield* writeError("start", "invalid", "Worker metadata is missing or invalid", {
            sessionId: valid.sessionId
          })
        }
        const previousRuns =
          agent !== null && delivery?.kind !== "answer"
            ? yield* sql<{
                readonly run_id: string
                readonly context: string
              }>`SELECT run_id, json_extract(metadata_json, '$.run_context') AS context FROM chat_runs WHERE session_id = ${valid.sessionId} ORDER BY started_at DESC, run_id DESC LIMIT 1`
            : []
        const previousRun = previousRuns[0]
        const occurrence =
          valid.automation ??
          (delivery?.kind === "result" && agent === null
            ? yield* wokenOccurrence({
                sql,
                sessionId: valid.sessionId,
                sourceRunId: delivery.runIds[0],
                now: timestamp
              }).pipe(Effect.mapError(arrivalConflict))
            : undefined)
        const answeredByUser =
          delivery?.kind === "answer" && delivery.timeout !== true && agent === null
        const sender =
          occurrence === undefined && delivery === undefined
            ? yield* handoffSender(sql, interaction, valid.sessionId)
            : undefined
        const handed =
          sender?.kind === "delegation" && sender.tool === "agent_message" && agent !== null
            ? undefined
            : sender
        const chatOrigin = {
          kind: "chat",
          session_id: valid.sessionId,
          turn_id: acceptedMessage.message_id
        } as const
        let runContext: RunContext
        if (sender?.kind === "continuation") runContext = sender.context
        else if (answeredByUser) runContext = { origin: chatOrigin, task: delivery.context.task }
        else if (delivery?.kind === "answer") runContext = delivery.context
        else if (valid.continuesTask !== undefined)
          runContext = {
            origin: chatOrigin,
            task: yield* bindInChatTask(sql, {
              itemId: valid.continuesTask.itemId,
              sessionId: valid.sessionId
            }).pipe(Effect.mapError((cause) => conflict(cause.message, "task_idle")))
          }
        else if (previousRun)
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
          causingRunId: delivery?.kind === "update" ? undefined : delivery?.runIds[0],
          interaction
        }).pipe(Effect.mapError(arrivalConflict))
        const scheduledPreviousRuns =
          occurrence === undefined
            ? []
            : yield* sql<{ readonly run_id: string }>`SELECT run_id FROM chat_runs
          WHERE session_id = ${valid.sessionId}
            AND json_extract(metadata_json, '$.run_context.origin') = ${JSON.stringify(runContext.origin)}
          ORDER BY started_at DESC, run_id DESC LIMIT 1`
        const previousRunId =
          delivery?.kind === "answer" && !answeredByUser
            ? delivery.runIds[0]
            : (previousRun?.run_id ?? scheduledPreviousRuns[0]?.run_id)
        const ownPolicy =
          sender?.kind === "continuation"
            ? sender.policy
            : yield* captureRunPolicy(sql, {
                runId,
                sessionId: valid.sessionId,
                spaceId: session.space_id,
                mode:
                  occurrence !== undefined ||
                  agent !== null ||
                  sender?.kind === "delegation" ||
                  (delivery?.kind === "answer" && runContext.origin.kind !== "chat")
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
                sharesRunId:
                  agent === null ? previousRunId : yield* spawnerRun(sql, valid.sessionId),
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
        if (valid.message.is_meta !== true && valid.automation === undefined && agent === null) {
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
        yield* sql`
        INSERT INTO chat_idempotency_keys (
          session_id, client_id, request_hash, run_id, message_id, message_json, status,
          created_at, updated_at
        ) VALUES (
          ${valid.sessionId}, ${valid.clientId}, ${valid.requestHash}, ${runId},
          ${acceptedMessage.message_id}, ${messageJson}, 'running', ${timestamp}, ${timestamp}
        )
      `

        if (valid.automation !== undefined) {
          if (valid.automationLease !== undefined) {
            if (valid.automationPrompt === undefined)
              return yield* writeError(
                "start",
                "invalid",
                "Handler input requires its captured prompt"
              )
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

        if (valid.deliveryId !== undefined) {
          yield* sql`UPDATE automation_deliveries SET status = 'delivered', delivered_at = ${timestamp},
          destinations = ${JSON.stringify([`chat:${runId}`])}
          WHERE delivery_id = ${valid.deliveryId} AND status = 'pending'`
        }

        if (agent !== null || (delivery?.kind === "answer" && runContext.origin.kind !== "chat")) {
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
                  ...(questionAnswer === undefined ? {} : { question_answer: questionAnswer }),
                  ...(agentResult === undefined
                    ? {}
                    : { is_meta_run: true, agent_result: agentResult }),
                  ...(interaction === undefined ? {} : { interaction }),
                  ...(delivery?.kind === "update" ? { update: delivery.update } : {}),
                  ...(automationRun === undefined
                    ? {}
                    : {
                        is_meta_run: true,
                        automation_task_id: automationRun.automationId,
                        automation_name: automationRun.name,
                        automation_prompt: automationRun.prompt,
                        automation_context_mode: automationRun.contextMode
                      })
                } satisfies ChatProjectionEvent,
                runId
              },
              {
                event: {
                  type: "TEXT_MESSAGE_START",
                  message_id: valid.assistantMessageId,
                  role: "assistant"
                } satisfies ChatProjectionEvent,
                runId
              },
              ...(valid.announce === true ||
              delivery?.kind === "connection" ||
              (interaction?.kind === "message" && interaction.from.type === "agent")
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
        yield* setCheckpoint(
          sql,
          chatEvents,
          valid.sessionId,
          runId,
          committed.headSequence,
          "start"
        )
        yield* sessionEvents.appendInTransaction("session_activity", valid.sessionId)
        const personalInput =
          valid.automation === undefined &&
          valid.deliveryId === undefined &&
          agent === null &&
          valid.message.is_meta !== true &&
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
        if (delivery?.kind !== "update" && delivery?.questionId) {
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
    ).pipe(Effect.mapError(mapFailure("start", { sessionId: valid.sessionId })))
  })

  const receive: ChatWriteStore["Service"]["receive"] = (input) =>
    prepareReceive(input).pipe(Effect.flatten)

  return {
    prepareReceive,
    receive,
    start: (input) =>
      receive({ ...input, wake: true }).pipe(
        Effect.flatMap((result) =>
          result._tag === "Stored"
            ? Effect.die("A waking admission cannot store an idle message")
            : Effect.succeed(result)
        )
      )
  }
}
