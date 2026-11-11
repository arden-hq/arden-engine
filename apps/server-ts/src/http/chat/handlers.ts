import type {
  CancelInput,
  ChatApprovalMode,
  ChatSentFrom,
  HistoryRouteOptions,
  ToolCallRouteOptions,
  TurnWorkRouteOptions
} from "@arden-hq/protocol/chat"
import { Effect, Option } from "effect"
import { randomUUID } from "node:crypto"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { ChatEventStream } from "../../chat/events.js"
import { ChatMessage } from "../../chat/message.js"
import { QueueHold } from "../../chat/queue-dispatch-runtime.js"
import {
  ChatMessageConflictError,
  mapToolStoreError,
  type ChatMessageFailure
} from "../../chat/message-errors.js"
import { DeferredCalls } from "../../tools/deferred-calls.js"
import { ChatHistory } from "../../chat/history.js"
import {
  ChatHistoryInvalidCursor,
  ChatSessionNotFound,
  ChatTurnNotFound,
  type ChatHistoryFailure
} from "../../chat/history-errors.js"
import { connectionChecks } from "../../connections/check.js"
import type { ConnectionCheckError } from "../../connections/recovery.js"
import {
  ChatWriteConflictError,
  ChatWriteStore,
  type ChatQueuedMessage,
  type ChatWriteFailure
} from "../../persistence/chat/store.js"
import { ToolExecutionStore, ToolExecutionStoreError } from "../../persistence/tools/store.js"
import { ArdenApi } from "../api.js"
import { LocalCaller } from "../middleware/local-only.js"
import { isRequestId } from "../middleware/request-id.js"
import {
  CHAT_OPEN_TIMING_REQUEST_HEADER,
  CHAT_OPEN_TIMING_RESPONSE_HEADER
} from "@arden-hq/protocol/chat-open-timing"
import { formatChatOpenServerTiming } from "../../chat/open-timing.js"
import { ServerToolRegistry } from "../../tools/registry.js"
import {
  failStore,
  OutputSchemaRejected,
  StoreConflict,
  StoreInvalid,
  storeErrorToHttp
} from "../errors.js"
import { ModelProviderService } from "../../models/provider.js"
import { outputSchemaProblem } from "../../models/structured-output.js"
import { CLI_DEFAULT_APPROVAL_MODE, isCliApprovalMode } from "@arden-hq/protocol/permissions"
import { makeCaptureRouter, type RouterDecision } from "../../routing/capture.js"
import { Decisions } from "../../models/decisions/service.js"
import { SpaceStore } from "../../persistence/spaces/store.js"
import { ModelStore } from "../../persistence/models/store.js"
import { SessionStore } from "../../persistence/sessions/store.js"
import { SummaryStore } from "../../persistence/summaries/store.js"
import { WorkStore } from "../../persistence/work/store.js"
import { makeSessionCreation } from "../../sessions/create.js"

const historyError = (
  error: ChatHistoryFailure
): HttpApiError.BadRequest | HttpApiError.NotFound | HttpApiError.InternalServerError => {
  if (error instanceof ChatHistoryInvalidCursor) return new HttpApiError.BadRequest({})
  if (error instanceof ChatSessionNotFound || error instanceof ChatTurnNotFound) {
    return new HttpApiError.NotFound({})
  }
  return new HttpApiError.InternalServerError({})
}

const messageError = (error: ChatMessageFailure) => {
  if (error instanceof ChatMessageConflictError) return new StoreConflict({})
  if (error.reason === "runner") return new HttpApiError.InternalServerError({})
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

const queueError = (error: ChatWriteFailure) => {
  if (error instanceof ChatWriteConflictError) return new StoreConflict({})
  if (error.reason === "terminal") return new HttpApiError.InternalServerError({})
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

const queuedMessageResponse = (message: ChatQueuedMessage) => ({
  client_id: message.clientId,
  message: message.message,
  images: message.images.map((image) => ({
    type: "image" as const,
    media_type: image.mediaType,
    data: image.data
  })),
  enqueued_at: message.enqueuedAt,
  ...(message.sentFrom === undefined ? {} : { sent_from: message.sentFrom }),
  ...(message.failedReason === undefined ? {} : { failed_reason: message.failedReason })
})

type ConnectionResultHttpError =
  | StoreConflict
  | StoreInvalid
  | HttpApiError.NotFound
  | HttpApiError.UnprocessableEntity
  | HttpApiError.ServiceUnavailable
  | HttpApiError.InternalServerError

const connectionStoreError = (error: ToolExecutionStoreError): ConnectionResultHttpError => {
  if (error.reason === "blocked") return new StoreConflict({})
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

const connectionCheckError = (error: ConnectionCheckError): ConnectionResultHttpError => {
  switch (error.reason) {
    case "rejected":
      return new HttpApiError.UnprocessableEntity({})
    case "unavailable":
      return new HttpApiError.ServiceUnavailable({})
    case "storage":
      return new HttpApiError.InternalServerError({})
  }
}

export const ChatHandlers = HttpApiBuilder.group(
  ArdenApi,
  "chat",
  Effect.fn(function* (handlers) {
    const message = yield* ChatMessage
    const queueHold = yield* QueueHold
    const models = yield* ModelProviderService
    const history = yield* ChatHistory
    const events = yield* ChatEventStream
    const checkConnection = yield* connectionChecks
    const tools = yield* ToolExecutionStore
    const toolRegistry = yield* ServerToolRegistry
    const deferred = yield* DeferredCalls
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
      if (decision.kind === "move") return { sessionId: decision.sessionId, name: decision.name }
      if (decision.kind === "keep") return undefined
      for (const space of [decision, ...decision.later]) {
        const opened = yield* sessionStore
          .ensureSpaceConversation(space.spaceId)
          .pipe(Effect.option)
        if (Option.isSome(opened)) return { sessionId: opened.value, name: space.spaceName }
      }
      return undefined
    })
    const sender = Effect.fn("ChatHandlers.sender")(function* (
      requested: ChatApprovalMode | undefined,
      sentFrom: ChatSentFrom | undefined
    ) {
      if ((yield* LocalCaller) !== "cli") return { approvalMode: requested, sentFrom }
      if (requested !== undefined && !isCliApprovalMode(requested))
        return yield* new HttpApiError.Forbidden({})
      return {
        approvalMode: requested ?? CLI_DEFAULT_APPROVAL_MODE,
        sentFrom: "cli" as const
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
              line: decision.kind === "keep" ? "Added your screenshot." : decision.line,
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
          return { kind: "kept" as const, session_id: created.sessionId, line: null }
        })
      )
      .handle("message", ({ payload }) => {
        if (
          payload.session_id === undefined ||
          payload.session_id === null ||
          payload.session_id.trim() === ""
        ) {
          return Effect.fail(new HttpApiError.BadRequest({}))
        }
        const route = models.current()
        const problem =
          payload.output_schema === undefined || route === undefined
            ? undefined
            : outputSchemaProblem(payload.output_schema, route.structuredOutputDialect)
        if (problem !== undefined) return Effect.fail(new OutputSchemaRejected({ detail: problem }))
        const sessionId = payload.session_id
        const clientId = payload.client_id ?? randomUUID()
        const capture = payload.capture
        return sender(payload.approval_mode, payload.sent_from).pipe(
          Effect.flatMap(({ approvalMode, sentFrom }) =>
            message
              .send({
                sessionId,
                clientId,
                message: payload.message,
                ...(payload.approval_reply === undefined
                  ? {}
                  : {
                      approvalReply: {
                        runId: payload.approval_reply.run_id,
                        toolId: payload.approval_reply.tool_id
                      }
                    }),
                ...(approvalMode === undefined ? {} : { approvalMode }),
                ...(payload.recipe === undefined ? {} : { recipe: payload.recipe }),
                ...(sentFrom === undefined ? {} : { sentFrom }),
                ...(payload.output_schema === undefined
                  ? {}
                  : { outputSchema: payload.output_schema }),
                ...(capture === undefined ? {} : { capture }),
                ...(payload.reply_to === undefined
                  ? {}
                  : {
                      replyTo: ("message_id" in payload.reply_to
                        ? [payload.reply_to]
                        : payload.reply_to
                      ).map((quoted) => ({
                        messageId: quoted.message_id,
                        role: quoted.role,
                        content: quoted.content
                      }))
                    }),
                ...(payload.images === undefined
                  ? {}
                  : {
                      images: payload.images.map((image) => ({
                        mediaType: image.media_type,
                        data: image.data
                      }))
                    })
              })
              .pipe(
                Effect.map((receipt) => ({
                  run_id: receipt.runId,
                  session_id: receipt.sessionId,
                  status: receipt.status,
                  ...(receipt.clientId === undefined ? {} : { client_id: receipt.clientId })
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
          let target: CancelInput
          if (payload.run_id !== undefined && payload.run_id !== null)
            target = { runId: payload.run_id }
          else if (payload.session_id !== undefined && payload.session_id !== null) {
            target = { sessionId: payload.session_id }
          } else return yield* new HttpApiError.BadRequest({})
          if (payload.hold_queue === true && target.sessionId !== undefined) {
            yield* queueHold.hold(target.sessionId)
          }
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
        deferred
          .decide({
            runId: payload.run_id,
            toolCallId: payload.tool_id,
            result: payload.result,
            ...(payload.approved === undefined ? {} : { approved: payload.approved }),
            ...(payload.grant_standing === undefined
              ? {}
              : { grantStanding: payload.grant_standing }),
            ...(payload.grant_list === undefined ? {} : { grantList: payload.grant_list }),
            ...(payload.attach_folder_to_space === undefined
              ? {}
              : { attachFolderToSpace: payload.attach_folder_to_space }),
            ...(payload.edited_arguments === undefined
              ? {}
              : { editedArguments: payload.edited_arguments }),
            ...(payload.alternative === undefined ? {} : { alternative: payload.alternative })
          })
          .pipe(
            Effect.mapError(mapToolStoreError),
            Effect.flatMap((decided) =>
              decided === "decided"
                ? Effect.succeed({ status: "ok" } as const)
                : message.resolveTool({
                    runId: payload.run_id,
                    toolId: payload.tool_id,
                    result: payload.result,
                    ...(payload.approved === undefined ? {} : { approved: payload.approved }),
                    ...(payload.grant_standing === undefined
                      ? {}
                      : { grantStanding: payload.grant_standing }),
                    ...(payload.grant_list === undefined ? {} : { grantList: payload.grant_list }),
                    ...(payload.attach_folder_to_space === undefined
                      ? {}
                      : { attachFolderToSpace: payload.attach_folder_to_space }),
                    ...(payload.edited_arguments === undefined
                      ? {}
                      : {
                          edits: {
                            patch: payload.edited_arguments,
                            apply: toolRegistry.applyApprovalEdits
                          }
                        }),
                    ...(payload.alternative === undefined
                      ? {}
                      : {
                          alternative: {
                            kind: payload.alternative,
                            offeredBy: toolRegistry.offersApprovalDraft
                          }
                        })
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
      )
      .handle(
        "connectionResult",
        Effect.fn("ChatHandlers.connectionResult")(function* ({ payload }) {
          const pending = yield* tools
            .pendingConnection({
              runId: payload.run_id,
              toolCallId: payload.tool_id
            })
            .pipe(Effect.mapError(connectionStoreError))
          if (pending === null) return yield* new HttpApiError.NotFound({})
          if (pending.snapshot.connection_id !== payload.connection_id) {
            return yield* new HttpApiError.Conflict({})
          }
          if (payload.approved) {
            yield* checkConnection(pending).pipe(Effect.mapError(connectionCheckError))
          }
          if (pending.snapshot.decision_delivery === "deferred") {
            const decided = yield* deferred
              .decide({
                runId: payload.run_id,
                toolCallId: payload.tool_id,
                approved: payload.approved,
                result: payload.result ?? ""
              })
              .pipe(Effect.mapError(connectionStoreError))
            if (decided !== "decided") return yield* new HttpApiError.Conflict({})
            return { status: "ok" } as const
          }
          return yield* message
            .resolveTool({
              runId: payload.run_id,
              toolId: payload.tool_id,
              approved: payload.approved,
              result: payload.result ?? (payload.approved ? "connected" : "not now")
            })
            .pipe(Effect.mapError(messageError))
        })
      )
      .handle(
        "connectionResume",
        Effect.fn("ChatHandlers.connectionResume")(function* () {
          const pending = yield* tools
            .allPendingConnections()
            .pipe(Effect.mapError(connectionStoreError))
          const resumed = yield* Effect.filter(pending, (decision) =>
            Effect.gen(function* () {
              yield* checkConnection(decision)
              if (decision.snapshot.decision_delivery === "deferred") {
                yield* deferred.decide({
                  runId: decision.snapshot.run_id,
                  toolCallId: decision.snapshot.tool_id,
                  approved: true,
                  result: ""
                })
              } else {
                yield* message.resolveTool({
                  runId: decision.snapshot.run_id,
                  toolId: decision.snapshot.tool_id,
                  approved: true,
                  result: "connected"
                })
              }
              return true
            }).pipe(
              Effect.catchTag("ConnectionCheckError", () => Effect.succeed(false)),
              Effect.catch((error) =>
                Effect.logWarning("Connection resume skipped a paused call", {
                  runId: decision.snapshot.run_id,
                  toolId: decision.snapshot.tool_id,
                  error
                }).pipe(Effect.as(false))
              )
            )
          )
          return {
            resumed: resumed.map(({ snapshot }) => ({
              run_id: snapshot.run_id,
              tool_id: snapshot.tool_id,
              connection_id: snapshot.connection_id
            }))
          }
        })
      )
      .handle("history", ({ query }) => {
        const input: HistoryRouteOptions = {
          ...(query.session_id === undefined ? {} : { sessionId: query.session_id }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.before === undefined ? {} : { before: query.before }),
          ...(query.after === undefined ? {} : { after: query.after }),
          ...(query.around === undefined ? {} : { around: query.around }),
          ...(query.around_seq === undefined ? {} : { aroundSeq: query.around_seq })
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
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.before === undefined ? {} : { before: query.before }),
          ...(query.after === undefined ? {} : { after: query.after }),
          ...(query.view === undefined ? {} : { view: query.view })
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
            path: query.path ?? ""
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
            request.headers[CHAT_OPEN_TIMING_REQUEST_HEADER] === "1" && requestId !== undefined
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
            images: (payload.images ?? []).map((image) => ({
              mediaType: image.media_type,
              data: image.data
            })),
            ...(payload.sent_from === undefined ? {} : { sentFrom: payload.sent_from })
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
