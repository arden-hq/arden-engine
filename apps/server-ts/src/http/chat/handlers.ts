import type {
  ChatApprovalMode,
  ChatSentFrom,
  HistoryRouteOptions,
  ToolCallRouteOptions,
  TurnWorkRouteOptions
} from "@arden-hq/protocol/chat"
import {
  cancelTarget,
  decisionFields,
  messageExtras,
  outputSchemaOf,
  queuedMessageResponse,
  receiptRun,
  cardChoices,
  requestedMode,
  sentFromField,
  sentFromOf
} from "./request-mapping.js"
import {
  CANCEL_TARGET,
  CHAT_SENT_FROM,
  chatDelivery,
  historyWindow,
  RELAY_COMMAND,
  turnWorkWindow
} from "@arden-hq/protocol/chat"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { ChatEventStream } from "../../chat/events.js"
import { ChatMessage } from "../../chat/message.js"
import { QueueHold } from "../../chat/queue-dispatch-runtime.js"
import { mapToolStoreError } from "../../chat/message-errors.js"
import { DEFERRED_DECISION, DeferredCalls } from "../../tools/deferred-calls.js"
import { ChatHistory } from "../../chat/history.js"
import { ChatWriteStore } from "../../persistence/chat/store.js"
import { ToolExecutionStoreError } from "../../persistence/tools/store.js"
import { ToolHistoryQueries } from "../../persistence/tools/history-queries.js"
import { grantedOnlyInTheApp } from "@arden-hq/protocol/tools"
import { ArdenApi } from "../api.js"
import { connectionDecisions } from "./connections.js"
import { historyError, messageError, queueError } from "./errors.js"
import { ServerConfig } from "../../config/service.js"
import { CallerIsTheApp, LOCAL_CALLER, LocalCaller } from "../middleware/local-only.js"
import { isRequestId } from "../middleware/request-id.js"
import {
  CHAT_OPEN_TIMING_REQUEST_HEADER,
  CHAT_OPEN_TIMING_REQUESTED,
  CHAT_OPEN_TIMING_RESPONSE_HEADER
} from "@arden-hq/protocol/chat-open-timing"
import { formatChatOpenServerTiming } from "../../chat/open-timing.js"
import { ServerToolRegistry } from "../../tools/registry.js"
import { failStore, OutputSchemaRejected, StoreInvalid } from "../errors.js"
import { ModelProviderService } from "../../models/provider.js"
import { outputSchemaProblem } from "../../models/structured-output.js"
import { commandLineApprovalMode } from "@arden-hq/protocol/permissions"
import { makeCaptureRouter, ROUTER_DECISION, type RouterDecision } from "../../routing/capture.js"
import { Decisions } from "../../models/decisions/service.js"
import { SpaceStore } from "../../persistence/spaces/store.js"
import { ModelStore } from "../../persistence/models/store.js"
import { SessionStore } from "../../persistence/sessions/store.js"
import { SummaryStore } from "../../persistence/summaries/store.js"
import { WorkStore } from "../../persistence/work/store.js"
import { keptCapture, makeSessionCreation } from "../../sessions/create.js"

const PHONE_NEEDS_UPDATE = "Update Arden on your iPhone to approve or deny from it."

export const ChatHandlers = HttpApiBuilder.group(
  ArdenApi,
  "chat",
  Effect.fn(function* (handlers) {
    const message = yield* ChatMessage
    const queueHold = yield* QueueHold
    const models = yield* ModelProviderService
    const history = yield* ChatHistory
    const events = yield* ChatEventStream
    const toolRegistry = yield* ServerToolRegistry
    const deferred = yield* DeferredCalls
    const toolHistory = yield* ToolHistoryQueries
    const connections = yield* connectionDecisions

    const refuseAppOnlyGrant = Effect.fn("ChatHandlers.refuseAppOnlyGrant")(function* (payload: {
      readonly run_id: string
      readonly tool_id: string
      readonly approved?: boolean | undefined
    }) {
      if (payload.approved !== true || (yield* CallerIsTheApp)) return
      const identity = { runId: payload.run_id, toolCallId: payload.tool_id }
      const toolName = yield* toolHistory.calledTool(identity)
      if (toolName === undefined)
        return yield* new ToolExecutionStoreError({
          operation: "resolve",
          reason: "not_found",
          message: "Nothing waits for this answer.",
          ...identity
        })
      const { tools: catalog } = yield* toolRegistry.catalog()
      if (!grantedOnlyInTheApp(catalog.find((tool) => tool.name === toolName)?.display)) return
      return yield* new ToolExecutionStoreError({
        operation: "resolve",
        reason: "conflict",
        message: "Grant this in Arden on your Mac.",
        ...identity
      })
    })
    const writes = yield* ChatWriteStore
    const sessionStore = yield* SessionStore
    const creation = makeSessionCreation({ store: sessionStore, models: yield* ModelStore })
    const routeCapture = makeCaptureRouter({
      spaces: yield* SpaceStore,
      work: yield* WorkStore,
      sessions: sessionStore,
      summaries: yield* SummaryStore,
      decisions: yield* Decisions
    })
    const captureTarget = Effect.fn("ChatHandlers.captureTarget")(function* (
      decision: RouterDecision
    ) {
      if (decision.kind === ROUTER_DECISION.move)
        return { sessionId: decision.sessionId, name: decision.name }
      if (decision.kind === ROUTER_DECISION.keep) return undefined
      for (const space of [decision, ...decision.later]) {
        const opened = yield* sessionStore
          .ensureSpaceConversation(space.spaceId)
          .pipe(Effect.option)
        if (Option.isSome(opened)) return { sessionId: opened.value, name: space.spaceName }
      }
      return undefined
    })
    const fixedApprovalMode = (yield* ServerConfig).approvalMode
    const sender = Effect.fn("ChatHandlers.sender")(function* (
      requested: ChatApprovalMode | undefined,
      sentFrom: ChatSentFrom | undefined
    ) {
      if (fixedApprovalMode !== undefined)
        return {
          approvalMode: fixedApprovalMode,
          sentFrom: (yield* LocalCaller) === LOCAL_CALLER.cli ? CHAT_SENT_FROM.cli : sentFrom
        }
      if ((yield* LocalCaller) !== LOCAL_CALLER.cli) return { approvalMode: requested, sentFrom }
      return {
        approvalMode: commandLineApprovalMode(requested),
        sentFrom: CHAT_SENT_FROM.cli
      }
    })

    return handlers
      .handle(
        "capture",
        Effect.fn("ChatHandlers.capture")(function* ({ payload }) {
          const image = { mediaType: payload.image.media_type, data: payload.image.data }
          const decision = yield* routeCapture({ image, note: payload.note })
          const target = yield* captureTarget(decision)
          if (target !== undefined) {
            const clientId = `capture:${payload.capture_id}`
            yield* message
              .send({
                sessionId: target.sessionId,
                clientId,
                message: payload.note,
                images: [image],
                announce: true,
                capture: "screenshot"
              })
              .pipe(Effect.mapError(messageError))
            return {
              kind: "moved" as const,
              session_id: target.sessionId,
              name: target.name,
              line:
                decision.kind === ROUTER_DECISION.keep ? "Added your screenshot." : decision.line,
              client_id: clientId
            }
          }
          const created = yield* creation({ origin: "capture" }).pipe(Effect.catch(failStore))
          yield* message
            .send({
              sessionId: created.sessionId,
              clientId: payload.capture_id,
              message: payload.note,
              images: [image],
              modelRole: "helper",
              announce: true,
              capture: "screenshot"
            })
            .pipe(Effect.mapError(messageError))
          return keptCapture(created.sessionId)
        })
      )
      .handle("message", ({ payload }) => {
        if (payload.session_id.trim() === "") return Effect.fail(new HttpApiError.BadRequest({}))
        const route = models.current()
        const outputSchema = outputSchemaOf(payload)
        const problem =
          outputSchema === undefined || route === undefined
            ? undefined
            : outputSchemaProblem(outputSchema, route.structuredOutputDialect)
        if (problem !== undefined) return Effect.fail(new OutputSchemaRejected({ detail: problem }))
        const sessionId = payload.session_id
        const clientId = payload.client_id
        return sender(requestedMode(payload.approval_mode), sentFromOf(payload.sent_from)).pipe(
          Effect.flatMap(({ approvalMode, sentFrom }) =>
            message
              .send({
                sessionId,
                clientId,
                message: payload.message,
                ...(approvalMode === undefined ? {} : { approvalMode }),
                ...(sentFrom === undefined ? {} : { sentFrom }),
                ...messageExtras(payload)
              })
              .pipe(
                Effect.map((receipt) => ({
                  run: receiptRun(receipt.runId),
                  session_id: receipt.sessionId,
                  status: receipt.status,
                  delivery: chatDelivery(receipt.status),
                  client_id: receipt.clientId
                })),
                Effect.mapError(messageError),
                Effect.ensuring(queueHold.release(sessionId))
              )
          )
        )
      })
      .handle(
        "cancel",
        Effect.fn("ChatHandlers.cancel")(function* ({ payload }) {
          const target = cancelTarget(payload)
          if (payload.kind === CANCEL_TARGET.session && payload.hold_queue)
            yield* queueHold.hold(payload.session_id)
          return yield* message.cancel(target).pipe(
            Effect.map((result) => ({
              status: result.status,
              run_id: result.runId,
              cancel_requested: result.cancelRequested,
              found: true as const
            })),
            Effect.mapError(messageError)
          )
        })
      )
      .handle("toolResult", ({ payload }) =>
        Effect.flatMap(LocalCaller, (caller) => {
          const commandId =
            (caller === LOCAL_CALLER.phone || caller === LOCAL_CALLER.other) &&
            payload.command.kind === RELAY_COMMAND.command
              ? payload.command.id
              : undefined
          const fields = decisionFields(payload)
          if (
            (caller === LOCAL_CALLER.phone || commandId !== undefined) &&
            fields.askedAt === undefined
          )
            return Effect.fail(new StoreInvalid({ detail: PHONE_NEEDS_UPDATE }))
          return refuseAppOnlyGrant({ ...payload, approved: fields.approved })
            .pipe(
              Effect.andThen(
                deferred.decide({
                  runId: payload.run_id,
                  toolCallId: payload.tool_id,
                  ...fields,
                  ...(commandId === undefined ? {} : { commandId })
                })
              )
            )
            .pipe(
              Effect.mapError(mapToolStoreError),
              Effect.flatMap((decided) =>
                decided === DEFERRED_DECISION.decided
                  ? Effect.succeed({ status: "ok" } as const)
                  : message.resolveTool({
                      runId: payload.run_id,
                      toolId: payload.tool_id,
                      ...cardChoices(fields, toolRegistry),
                      ...(commandId === undefined ? {} : { commandId })
                    })
              ),
              Effect.tapError((error) =>
                Effect.logError("Tool approval resolution failed", {
                  runId: payload.run_id,
                  toolId: payload.tool_id,
                  error
                })
              ),
              Effect.mapError(messageError)
            )
        })
      )
      .handle("connectionResult", connections.result)
      .handle("connectionResume", connections.resume)
      .handle("history", ({ query }) => {
        const input: HistoryRouteOptions = {
          sessionId: query.session_id,
          limit: query.limit,
          window: historyWindow(query)
        }
        return history.get(input).pipe(
          Effect.tapError((error) =>
            Effect.logError("Chat history failed", {
              sessionId: query.session_id,
              error
            })
          ),
          Effect.mapError(historyError)
        )
      })
      .handle("turnWork", ({ query }) => {
        const input: TurnWorkRouteOptions = {
          sessionId: query.session_id,
          turnId: query.turn_id,
          limit: query.limit,
          window: turnWorkWindow(query),
          view: query.view
        }
        return history.getTurnWork(input).pipe(
          Effect.tapError((error) =>
            Effect.logError("Chat turn work failed", {
              sessionId: query.session_id,
              turnId: query.turn_id,
              error
            })
          ),
          Effect.mapError(historyError)
        )
      })
      .handle("turnDetails", ({ query }) =>
        history.getTurnDetails({ sessionId: query.session_id, turnId: query.turn_id }).pipe(
          Effect.tapError((error) =>
            Effect.logError("Chat turn details failed", {
              sessionId: query.session_id,
              turnId: query.turn_id,
              error
            })
          ),
          Effect.mapError(historyError)
        )
      )
      .handle("toolCall", ({ query }) => {
        const input: ToolCallRouteOptions = {
          sessionId: query.session_id,
          turnId: query.turn_id,
          toolCallId: query.tool_call_id
        }
        return history.getToolCall(input).pipe(
          Effect.tapError((error) =>
            Effect.logError("Chat tool call lookup failed", {
              sessionId: query.session_id,
              toolCallId: query.tool_call_id,
              error
            })
          ),
          Effect.mapError(historyError)
        )
      })
      .handle("toolResultValue", ({ params, query }) =>
        history
          .getToolResultValue({
            sessionId: params.sessionId,
            toolCallId: params.toolCallId,
            path: query.path
          })
          .pipe(
            Effect.tapError((error) =>
              Effect.logError("Tool result value lookup failed", {
                sessionId: params.sessionId,
                toolCallId: params.toolCallId,
                error
              })
            ),
            Effect.mapError(historyError)
          )
      )
      .handle(
        "events",
        Effect.fn("ChatHandlers.events")(function* ({ params }) {
          const request = yield* HttpServerRequest.HttpServerRequest
          const requestId = isRequestId(request.headers["x-request-id"])
            ? request.headers["x-request-id"]
            : undefined
          const collectTiming =
            request.headers[CHAT_OPEN_TIMING_REQUEST_HEADER] === CHAT_OPEN_TIMING_REQUESTED &&
            requestId !== undefined
          const opened = yield* events
            .open({ sessionId: params.sessionId, requestId, collectTiming })
            .pipe(
              Effect.catchTag("ChatStreamError", (error) =>
                Effect.logError("Chat event stream failed to open", {
                  sessionId: params.sessionId,
                  error
                }).pipe(Effect.andThen(Effect.fail(new HttpApiError.InternalServerError({}))))
              )
            )
          return HttpApiSchema.withHeaders({
            body: opened.stream,
            headers:
              opened.timings === undefined
                ? {}
                : {
                    [CHAT_OPEN_TIMING_RESPONSE_HEADER]: formatChatOpenServerTiming(opened.timings)
                  }
          })
        })
      )
      .handle("listQueued", ({ params }) =>
        writes.listQueued(params.sessionId).pipe(
          Effect.map((messages) => ({
            session_id: params.sessionId,
            messages: messages.map(queuedMessageResponse)
          })),
          Effect.mapError(queueError)
        )
      )
      .handle("enqueue", ({ params, payload }) =>
        writes
          .enqueue({
            sessionId: params.sessionId,
            clientId: payload.client_id,
            message: payload.message,
            images: payload.images.map((image) => ({
              mediaType: image.media_type,
              data: image.data
            })),
            ...sentFromField(payload.sent_from)
          })
          .pipe(Effect.map(queuedMessageResponse), Effect.mapError(queueError))
      )
      .handle("reorderQueued", ({ params, payload }) =>
        writes
          .reorderQueued({
            sessionId: params.sessionId,
            clientIds: payload.client_ids
          })
          .pipe(
            Effect.map((messages) => ({
              session_id: params.sessionId,
              messages: messages.map(queuedMessageResponse)
            })),
            Effect.mapError(queueError)
          )
      )
      .handle("cancelQueued", ({ params }) =>
        writes
          .cancelQueued({
            sessionId: params.sessionId,
            clientId: params.clientId
          })
          .pipe(
            Effect.mapError(queueError),
            Effect.flatMap((cancelled) =>
              cancelled
                ? Effect.succeed({ status: "cancelled" as const, client_id: params.clientId })
                : Effect.fail(new HttpApiError.NotFound({}))
            )
          )
      )
  })
)
