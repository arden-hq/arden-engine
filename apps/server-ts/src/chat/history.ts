import type {
  HistoryResponse,
  HistoryMessage,
  HistoryRouteOptions,
  TurnDetailsResponse,
  TurnDetailsRouteOptions,
  TurnWorkResponse,
  TurnWorkRouteOptions,
  ToolCallRouteOptions,
  ToolCallResponse,
  ToolResultValueRouteOptions,
  ToolResultValueResponse
} from "@arden-hq/protocol/chat"
import { readToolResult } from "@arden-hq/answer-ui/tool-result"
import { Context, Effect, Layer, Predicate } from "effect"
import type { SessionHistoryHeader } from "../persistence/sessions/model.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { RunQueries } from "../persistence/runs/queries.js"
import type { TranscriptMessageRecord, TranscriptPage } from "../persistence/transcript/model.js"
import {
  TranscriptQueries,
  type TranscriptQueryFailure
} from "../persistence/transcript/queries.js"
import { SessionTurnQueries } from "../persistence/turns/queries.js"
import { ChatEventStore } from "../persistence/events/store.js"
import { ModelStore } from "../persistence/models/store.js"
import {
  ToolHistoryQueries,
  type ToolExecutionResultMetadata
} from "../persistence/tools/history-queries.js"
import type { ToolExecutionStoreError } from "../persistence/tools/store.js"
import { boundActiveWorkTail } from "./history-budget.js"
import {
  ChatHistoryError,
  ChatSessionNotFound,
  ChatTurnNotFound,
  type ChatHistoryFailure
} from "./history-errors.js"
import {
  activeRunSnapshot,
  compactTurnWork,
  contentText,
  emptyHistory,
  historyPage,
  historyToolCallIds,
  historyToolCalls,
  isConversationRecord,
  mergeTurnWorkRecords,
  pinnedConversationCalls,
  projectMessages,
  requireTurnStamps,
  toolResultTexts,
  type StampedTranscriptMessageRecord
} from "./history-projection.js"
import { loadStableSnapshot, loadStableTurnWorkSnapshot } from "./history-snapshot.js"
import { chatOpenTimer, logChatOpenTiming } from "./open-timing.js"

const TURN_WORK_PAGE_CARRIERS = 100
const TURN_DETAILS_PAGES = 10

interface ContextBudgetInput {
  readonly model: string | null
  readonly inputTokens: number
  readonly messageCount: number
}

type ContextBudget = HistoryResponse["context_budget"]

export interface ChatHistoryLiveOptions {
  readonly contextBudget: (
    input: ContextBudgetInput
  ) => Effect.Effect<ContextBudget, ChatHistoryError>
}

export interface ChatHistoryShape {
  readonly get: (input: HistoryRouteOptions) => Effect.Effect<HistoryResponse, ChatHistoryFailure>
  readonly getTurnWork: (
    input: TurnWorkRouteOptions
  ) => Effect.Effect<TurnWorkResponse, ChatHistoryFailure>
  readonly getTurnDetails: (
    input: TurnDetailsRouteOptions
  ) => Effect.Effect<TurnDetailsResponse, ChatHistoryFailure>
  readonly getToolCall: (
    input: ToolCallRouteOptions
  ) => Effect.Effect<ToolCallResponse, ChatHistoryFailure>
  readonly getToolResultValue: (
    input: ToolResultValueRouteOptions
  ) => Effect.Effect<ToolResultValueResponse, ChatHistoryFailure>
}

export class ChatHistory extends Context.Service<ChatHistory, ChatHistoryShape>()(
  "@arden-hq/server/chat/ChatHistory"
) {
  static readonly modelLayer = Layer.unwrap(
    Effect.gen(function* () {
      const models = yield* ModelStore
      return ChatHistory.layer({
        contextBudget: (input) =>
          models
            .contextBudget({
              modelId: input.model,
              inputTokens: input.inputTokens,
              messageCount: input.messageCount
            })
            .pipe(
              Effect.catch((error) =>
                error.reason === "unavailable"
                  ? Effect.succeed({
                      model: input.model,
                      hard_limit: null,
                      compaction_trigger: null,
                      input_tokens: input.inputTokens,
                      message_count: input.messageCount
                    })
                  : Effect.fail(
                      new ChatHistoryError({
                        message: "Could not resolve the Chat context budget",
                        cause: error
                      })
                    )
              )
            )
      })
    })
  )

  static layer(options: ChatHistoryLiveOptions) {
    return Layer.effect(
      ChatHistory,
      Effect.gen(function* () {
        const sessions = yield* SessionQueries
        const runs = yield* RunQueries
        const transcript = yield* TranscriptQueries
        const turns = yield* SessionTurnQueries
        const journal = yield* ChatEventStore
        const tools = yield* ToolHistoryQueries

        const agentParentSource = Effect.fn("ChatHistory.agentParentSource")(function* (
          header: SessionHistoryHeader
        ) {
          if (header.sessionType !== "agent" || header.parentSessionId === null) return undefined
          const parent = yield* sessions.loadHistoryHeader(header.parentSessionId)
          return parent === null
            ? undefined
            : { session_id: parent.sessionId, session_ref: parent.publicRef }
        })

        const get = Effect.fn("ChatHistory.get")(function* (
          input: HistoryRouteOptions
        ): Effect.fn.Return<HistoryResponse, ChatHistoryFailure> {
          const timer = chatOpenTimer()
          const header = yield* sessions.loadHistoryHeader(input.sessionId)
          if (header === null) {
            if (input.sessionId !== undefined) {
              return yield* new ChatSessionNotFound({ sessionId: input.sessionId })
            }
            return yield* options
              .contextBudget({
                model: null,
                inputTokens: 0,
                messageCount: 0
              })
              .pipe(Effect.map(emptyHistory), Effect.withSpan("ChatHistory.emptyHistory"))
          }

          const sessionId = header.sessionId
          const parentSource = yield* agentParentSource(header)
          const headerMs = timer?.mark()
          const snapshot = yield* loadStableSnapshot(transcript, runs, journal, sessionId, input)
          const stableSnapshotMs = timer?.mark()
          const page = snapshot.page
          const records = yield* requireTurnStamps(page.records, sessionId)
          const activeWorkTail =
            snapshot.work === null
              ? null
              : boundActiveWorkTail(
                  compactTurnWork(
                    yield* projectTurnWork(
                      tools,
                      sessionId,
                      snapshot.work.turnId,
                      snapshot.work.page,
                      snapshot.work.results,
                      parentSource
                    )
                  )
                )
          const workProjectionMs = timer?.mark()
          const watermark = snapshot.watermark
          const run = snapshot.run
          const blockingWork = yield* sessions.blockingWork(sessionId)
          const blockingWorkMs = timer?.mark()
          const pendingApprovals = [
            ...(yield* tools.pendingApprovals(sessionId)),
            ...(yield* tools.pendingDescendantApprovals(sessionId))
          ]
          const approvalsMs = timer?.mark()
          const pendingConnections = [
            ...(yield* tools.pendingConnections(sessionId)),
            ...(yield* tools.pendingDescendantConnections(sessionId))
          ].map((connection) => connection.snapshot)
          const connectionsMs = timer?.mark()
          const turnIds = [
            ...new Set([
              ...records.map((record) => record.envelope.turn_id),
              ...(snapshot.work === null ? [] : [snapshot.work.turnId])
            ])
          ]
          const turnShells = yield* turns.shellsFor(sessionId, turnIds)
          const turnIdsWithWork = yield* transcript.turnIdsWithWork(sessionId, turnIds)
          const turnIdsWithToolWork = yield* transcript.turnIdsWithToolWork(sessionId, turnIds)
          const toolCallCounts = yield* transcript.toolCallCounts(sessionId, turnIds)
          const metadataMs = timer?.mark()
          const waitingToolCallIds = run === null ? [] : yield* runs.waitingToolCalls(run.runId)
          const activeRun = activeRunSnapshot(
            run,
            watermark.headSequence,
            watermark.checkpointSequence,
            pendingApprovals,
            pendingConnections,
            waitingToolCallIds
          )
          const messages = yield* projectConversationMessages(
            transcript,
            tools,
            sessionId,
            records,
            parentSource
          )
          const messageProjectionMs = timer?.mark()
          const budget = yield* options.contextBudget({
            model: header.chatModel,
            inputTokens: header.lastInputTokens ?? 0,
            messageCount: header.activeMessageCount
          })

          if (timer !== undefined)
            yield* logChatOpenTiming("chat.history_timing", {
              headerMs,
              stableSnapshotMs,
              workProjectionMs,
              blockingWorkMs,
              approvalsMs,
              connectionsMs,
              metadataMs,
              messageProjectionMs,
              budgetMs: timer.mark(),
              totalMs: timer.total(),
              pageRows: page.records.length,
              turnCount: turnIds.length,
              approvalCount: pendingApprovals.length,
              connectionCount: pendingConnections.length,
              activeRun: run !== null
            })

          return {
            messages,
            active_work_tail: activeWorkTail,
            runtime: {
              session_id: sessionId,
              latest_event_seq: watermark.headSequence,
              checkpoint_seq: watermark.checkpointSequence,
              active_run: activeRun,
              blocking_work: blockingWork,
              pending_approvals: pendingApprovals,
              pending_connections: pendingConnections
            },
            page: historyPage(page),
            context_budget: budget,
            turn_shells: turnShells.map((shell) => ({
              turn_id: shell.turnId,
              message_start_seq: shell.messageStartSeq,
              message_end_seq: shell.messageEndSeq,
              started_at: shell.startedAt,
              ended_at: shell.endedAt,
              has_work: turnIdsWithWork.has(shell.turnId),
              has_tool_work: turnIdsWithToolWork.has(shell.turnId),
              tool_calls: toolCallCounts.get(shell.turnId) ?? [],
              ...(shell.failure === undefined
                ? {}
                : { error_code: shell.failure.code, error_message: shell.failure.message })
            }))
          }
        })

        const getTurnWork = Effect.fn("ChatHistory.getTurnWork")(function* (
          input: TurnWorkRouteOptions
        ): Effect.fn.Return<TurnWorkResponse, ChatHistoryFailure> {
          const header = yield* sessions.loadHistoryHeader(input.sessionId)
          if (header === null) {
            return yield* new ChatSessionNotFound({ sessionId: input.sessionId })
          }
          const shells = yield* turns.shellsFor(input.sessionId, [input.turnId])
          if (shells.length === 0) {
            return yield* new ChatTurnNotFound({
              sessionId: input.sessionId,
              turnId: input.turnId
            })
          }
          const parentSource = yield* agentParentSource(header)
          const snapshot = yield* loadStableTurnWorkSnapshot(transcript, journal, input)
          const response = yield* projectTurnWork(
            tools,
            input.sessionId,
            input.turnId,
            snapshot.page,
            snapshot.results,
            parentSource
          )
          return input.view === "compact" ? compactTurnWork(response) : response
        })
        const getTurnDetails = Effect.fn("ChatHistory.getTurnDetails")(function* (
          input: TurnDetailsRouteOptions
        ): Effect.fn.Return<TurnDetailsResponse, ChatHistoryFailure> {
          const header = yield* sessions.loadHistoryHeader(input.sessionId)
          if (header === null) {
            return yield* new ChatSessionNotFound({ sessionId: input.sessionId })
          }
          const shells = yield* turns.shellsFor(input.sessionId, [input.turnId])
          if (shells.length === 0) {
            return yield* new ChatTurnNotFound({
              sessionId: input.sessionId,
              turnId: input.turnId
            })
          }
          const parentSource = yield* agentParentSource(header)
          const pages: Array<TurnWorkResponse> = []
          let before: string | undefined
          let complete = false
          for (let read = 0; read < TURN_DETAILS_PAGES; read += 1) {
            const snapshot = yield* loadStableTurnWorkSnapshot(transcript, journal, {
              sessionId: input.sessionId,
              turnId: input.turnId,
              limit: TURN_WORK_PAGE_CARRIERS,
              view: "compact",
              ...(before === undefined ? {} : { before })
            })
            const page = yield* projectTurnWork(
              tools,
              input.sessionId,
              input.turnId,
              snapshot.page,
              snapshot.results,
              parentSource
            )
            pages.unshift(compactTurnWork(page))
            complete = !page.page.has_more_before
            before = page.page.before ?? undefined
            if (complete || before === undefined) break
          }
          return {
            turn_id: input.turnId,
            messages: pages.flatMap((page) => page.messages),
            complete
          }
        })
        const getToolCall = Effect.fn("ChatHistory.getToolCall")(function* (
          input: ToolCallRouteOptions
        ): Effect.fn.Return<ToolCallResponse, ChatHistoryFailure> {
          const header = yield* sessions.loadHistoryHeader(input.sessionId)
          if (header === null) {
            return yield* new ChatSessionNotFound({ sessionId: input.sessionId })
          }
          const carrier = yield* transcript.toolCallCarrier(
            input.sessionId,
            input.turnId,
            input.toolCallId
          )
          const call =
            carrier === null
              ? undefined
              : historyToolCalls(carrier.envelope.tool_calls).find(
                  (candidate) => candidate.id === input.toolCallId
                )
          if (call === undefined) {
            const recorded = yield* tools.ledgerToolCall(input)
            if (recorded === undefined) {
              return yield* new ChatTurnNotFound({
                sessionId: input.sessionId,
                turnId: input.turnId
              })
            }
            return {
              tool_call_id: input.toolCallId,
              name: recorded.name,
              arguments: recorded.arguments,
              result: recorded.result ?? null,
              is_error: recorded.isError
            }
          }
          const results = yield* transcript.toolResultsFor(
            input.sessionId,
            [input.turnId],
            [input.toolCallId]
          )
          const result = results.find((record) => record.envelope.tool_call_id === input.toolCallId)
          const isError =
            result !== undefined && Predicate.isBoolean(result.envelope.is_error)
              ? result.envelope.is_error
              : call.is_error
          return {
            tool_call_id: call.id,
            name: call.name,
            arguments: call.arguments,
            result: result === undefined ? null : contentText(result.envelope.content),
            ...(isError === undefined ? {} : { is_error: isError })
          }
        })

        const getToolResultValue = Effect.fn("ChatHistory.getToolResultValue")(function* (
          input: ToolResultValueRouteOptions
        ): Effect.fn.Return<ToolResultValueResponse, ChatHistoryFailure> {
          const header = yield* sessions.loadHistoryHeader(input.sessionId)
          if (header === null) {
            return yield* new ChatSessionNotFound({ sessionId: input.sessionId })
          }
          const record = yield* transcript.toolResultInSession(input.sessionId, input.toolCallId)
          if (record === null) return { status: "unavailable", reason: "no_call" }
          return readToolResult(contentText(record.envelope.content), input.path)
        })

        return ChatHistory.of({
          get,
          getTurnWork,
          getTurnDetails,
          getToolCall,
          getToolResultValue
        })
      })
    )
  }
}

const projectConversationMessages = Effect.fn("ChatHistory.projectConversationMessages")(function* (
  transcript: TranscriptQueries["Service"],
  tools: ToolHistoryQueries["Service"],
  sessionId: string,
  records: ReadonlyArray<StampedTranscriptMessageRecord>,
  parentSource: HistoryMessage["from_chat"]
): Effect.fn.Return<
  HistoryResponse["messages"],
  ChatHistoryError | ToolExecutionStoreError | TranscriptQueryFailure
> {
  const pinnedByTurn = pinnedConversationCalls(records)
  const pinnedIds = [...pinnedByTurn.values()].flat()
  const pinnedResults = toolResultTexts(
    yield* transcript.toolResultsFor(sessionId, [...pinnedByTurn.keys()], pinnedIds)
  )
  const resultMetadata =
    pinnedIds.length === 0
      ? new Map<string, ToolExecutionResultMetadata>()
      : yield* tools.historyResultMetadata({ sessionId, toolCallIds: pinnedIds })
  return yield* projectMessages(
    records.filter(isConversationRecord),
    resultMetadata,
    "conversation",
    {
      pinnedResults,
      parentSource,
      assignment: parentSource === undefined ? undefined : yield* tools.agentAssignment(sessionId)
    }
  )
})

const projectTurnWork = Effect.fn("ChatHistory.projectTurnWork")(function* (
  tools: ToolHistoryQueries["Service"],
  sessionId: string,
  turnId: string,
  carrierPage: TranscriptPage,
  resultRecords: ReadonlyArray<TranscriptMessageRecord>,
  parentSource: HistoryMessage["from_chat"]
): Effect.fn.Return<TurnWorkResponse, ChatHistoryError | ToolExecutionStoreError> {
  const records = mergeTurnWorkRecords(
    yield* requireTurnStamps(carrierPage.records, sessionId),
    yield* requireTurnStamps(resultRecords, sessionId)
  )
  const resultMetadata = yield* tools.historyResultMetadata({
    sessionId,
    toolCallIds: historyToolCallIds(records)
  })
  const messages = yield* projectMessages(records, resultMetadata, "work", { parentSource })
  return {
    turn_id: turnId,
    messages,
    page: historyPage(carrierPage)
  }
})
