import { ROLE } from "@arden-hq/std/message-vocabulary"
import { isWrittenByPerson } from "../persistence/transcript/model.js"
import { makeAgent, resolveModelCapabilities, usageInputTokens } from "@arden-hq/loop"
import type {
  AgentStreamEvent,
  ChatMessage,
  ModelRequest,
  ModelRequestNext,
  Toolset,
  ToolCallRequest,
  ToolResult
} from "@arden-hq/loop"
import type {
  ChatRunner,
  ChatRunnerContextReport,
  ChatRunnerInput,
  ChatRunnerToolRequest
} from "./runner-contract.js"
import { ToolEffectSchema } from "../execution/tool-effect.js"
import { Option, Schema } from "effect"
import { persistToolCallHost } from "../execution/tool-call-presentation.js"
import { observeModelRequests } from "./request-observation.js"
import { makeModelRequestMeter, responseUsage } from "./model-request-meter.js"
import { appendDeveloperContext, DEVELOPER_CONTEXT_SOURCE } from "./developer-context.js"
import { makeLocalInstructionRuntime } from "./local-instruction-runtime.js"
import { answerBlockCorrection } from "./ui-blocks.js"
import { answerFixInHistory } from "./loop-events.js"
import { seenToolResult } from "../context/tool-result-ids.js"
import { producingTaskDirection } from "../context/runtime-update.js"
import { DIRECTION_REVIEW_HOST } from "../persistence/tools/mutation-receipt.js"
import { chatStepOutputLimit, outputLimitDelivery } from "../models/side-call.js"
import { type LoopChatRunnerOptions } from "./loop-runner-options.js"
import {
  initialMessages,
  labelToolResultsMiddleware,
  makeCompactionMiddleware,
  makeMessageIdMinter,
  makeStepLimitMiddleware,
  makeSystemContextMiddleware,
  makeTodoReminderMiddleware,
  makeToolHistoryRepairMiddleware,
  ownerInstructionsMiddleware,
  projectAnswerBlocksMiddleware,
  projectIdleGapMiddleware,
  toLoopMessages
} from "./loop-runner-middleware.js"

export const makeLoopChatRunner = (config: LoopChatRunnerOptions): ChatRunner =>
  async function* loopChatRunner(originalInput: ChatRunnerInput): AsyncIterable<AgentStreamEvent> {
    await originalInput.executionBudget()
    const input = originalInput
    const localInstructions =
      config.localInstructions === undefined
        ? undefined
        : makeLocalInstructionRuntime({
            load: config.localInstructions,
            record: config.recordLocalInstructions,
            input,
            ...(config.localInstructionDirectories === undefined
              ? {}
              : { directories: config.localInstructionDirectories })
          })
    if (input.model === null) {
      throw new Error("The Loop Chat runner requires a selected ModelHost model")
    }
    const capabilities = await resolveModelCapabilities({
      provider: config.provider,
      model: input.model
    })
    const imageInput = capabilities.imageInput
    const window = config.modelContext?.(input.model)
    const maxOutputTokens =
      window === undefined
        ? undefined
        : chatStepOutputLimit({ context: window, delivery: outputLimitDelivery(capabilities) })
    let directionReviews = 0
    const counted = (result: ToolResult): ToolResult => {
      if (result.host?.["not_run"] === DIRECTION_REVIEW_HOST.not_run) directionReviews += 1
      return result
    }
    const sourceToolset =
      typeof config.toolset === "function"
        ? await config.toolset({
            sessionId: input.sessionId,
            runId: input.runId,
            approvalMode: input.approvalMode,
            automationId: input.automationId,
            executeTool: (request, operation, options) =>
              input.tools.execute(request, operation, options).then(counted),
            executeDetachedTool: input.tools.executeDetached,
            spawnAgent: input.tools.spawnAgent,
            cancelAgent: input.tools.cancelAgent,
            sendMessage: input.tools.sendMessage,
            detachedRun: input.tools.detachedRun,
            emitToolProgress: input.tools.emitToolProgress,
            emitToolOutput: input.tools.emitToolOutput,
            declareEffectTarget: input.tools.declareEffectTarget,
            modelUsage: { admit: input.admitModelRequest, record: input.recordModelUsage },
            ...(imageInput === undefined ? {} : { imageInput })
          })
        : config.toolset
    const toolMetadata = (name: string) => sourceToolset.metadata?.(name)
    const durableRequest = async (request: {
      readonly toolCallId: string
      readonly name: string
      readonly args: Readonly<Record<string, unknown>>
    }): Promise<ChatRunnerToolRequest> => {
      const metadata = await toolMetadata(request.name)
      const source = metadata?.host?.source
      const effect = Schema.decodeUnknownOption(ToolEffectSchema)(metadata?.host?.effect)
      return {
        ...request,
        changesState: metadata?.changes_state === true,
        ...(Option.isSome(effect) ? { effect: effect.value } : {}),
        ...(typeof source === "string" && source.length > 0 ? { source } : {})
      }
    }

    const executeDurably = async (
      request: ToolCallRequest,
      operation: (request: ToolCallRequest) => Promise<ToolResult> | ToolResult
    ): Promise<ToolResult> => {
      const shown =
        request.messages === undefined
          ? undefined
          : producingTaskDirection(request.messages, request.toolCallId)
      request.phase?.("waiting")
      const result = await input.tools.execute(
        { ...(await durableRequest(request)), plan: { kind: "turn", shown } },
        (context) =>
          operation({
            ...request,
            ...(context?.approval === undefined ? {} : { approval: { ...context.approval } }),
            ...(context === undefined
              ? {}
              : {
                  beforeExecute: async () =>
                    (await request.beforeExecute?.()) ?? (await context.admit())
                })
          }),
        request.backgrounded === undefined ? {} : { backgrounded: request.backgrounded }
      )
      return counted(result)
    }
    const toolset: Toolset = {
      ...sourceToolset,
      settleRefusal: (request, result) => executeDurably(request, () => result),
      execute: (request) =>
        executeDurably(request, async (effectiveRequest) => {
          const preflight = await localInstructions?.preflight(
            effectiveRequest,
            (await toolMetadata(request.name))?.host
          )
          return preflight ?? sourceToolset.execute(effectiveRequest)
        })
    }

    let context: ChatRunnerContextReport | undefined
    let seenMessages: ReadonlyArray<ChatMessage> = []
    const meter = makeModelRequestMeter({
      admit: input.admitModelRequest,
      signal: input.signal,
      report: (timing) => input.reportModelTiming?.(timing)
    })
    const observe = observeModelRequests(input.sessionId, config.onRequestComplete)
    const openSession = config.provider.openSession
    const compact = config.compact
    const localTime = config.localTime
    const todoReminder = config.todoReminder
    const ownerWords = config.ownerWords
    const maxSteps = config.config?.maxIterations
    const preloadTools = await config.preloadTools?.({
      sessionId: input.sessionId,
      runId: input.runId,
      automationId: input.automationId
    })
    const agent = makeAgent(
      {
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...config.config,
        model: input.model,
        cacheScope: input.treeRootSessionId,
        modelRequestMiddlewares: [
          meter.middleware,
          makeToolHistoryRepairMiddleware(config.onOrphanToolOutputs, input),
          projectIdleGapMiddleware,
          projectAnswerBlocksMiddleware,
          labelToolResultsMiddleware,
          ...(ownerWords === undefined ? [] : [ownerInstructionsMiddleware(ownerWords, input)]),
          ...(todoReminder === undefined ? [] : [makeTodoReminderMiddleware(todoReminder, input)]),
          ...(localTime === undefined
            ? []
            : [
                async (request: ModelRequest, next: ModelRequestNext) =>
                  appendDeveloperContext({
                    request: await next(request),
                    input,
                    source: DEVELOPER_CONTEXT_SOURCE.localTime,
                    content: localTime()
                  })
              ]),
          ...(maxSteps === undefined ? [] : [makeStepLimitMiddleware(input, maxSteps)]),
          ...(config.systemContext === undefined
            ? []
            : [makeSystemContextMiddleware(config.systemContext, input, () => directionReviews)]),
          ...(localInstructions === undefined ? [] : [localInstructions.modelMiddleware]),
          ...(compact === undefined
            ? []
            : [
                makeCompactionMiddleware(
                  (request) => meter.measure("compaction", () => compact(request)),
                  input
                )
              ]),
          ...(config.config?.modelRequestMiddlewares ?? [])
        ],
        toolCallMiddlewares: [],
        mintMessageId: makeMessageIdMinter(
          input.assistantMessageId,
          input.messages,
          input.mintedMessageIds
        ),
        ...(input.reasoningEffort === null ? {} : { reasoningEffort: input.reasoningEffort })
      },
      {
        persistHost: persistToolCallHost,
        ...(preloadTools === undefined ? {} : { preloadTools }),
        ...config.agentOptions,
        provider: {
          ...config.provider,
          stream: meter.stream(observe(config.provider.stream)),
          ...(openSession === undefined
            ? {}
            : {
                openSession: async () => {
                  const session = await openSession()
                  return { ...session, stream: meter.stream(observe(session.stream)) }
                }
              })
        },
        toolset,
        hooks: {
          ...config.agentOptions?.hooks,
          onResponse: async (response, messages, change) => {
            seenMessages = messages
            await meter.measure("accounting", () =>
              input.recordModelUsage({ sampleId: meter.sampleId(), usage: responseUsage(response) })
            )
            const inputTokens = usageInputTokens(response.usage)
            if (inputTokens > 0) {
              context = {
                inputTokens,
                usage: {
                  prompt: response.usage.prompt_tokens ?? 0,
                  completion: response.usage.completion_tokens ?? 0,
                  cache_read: response.usage.cache_read_tokens ?? 0,
                  cache_write: response.usage.cache_write_tokens ?? 0
                }
              }
            }
            if (!input.signal.aborted) {
              await meter.measure("checkpoint", () =>
                input.checkpointMessages(messages, context, undefined, change)
              )
            }
            await config.agentOptions?.hooks?.onResponse?.(response, messages, change)
          },
          onCheckpoint: async (messages, change) => {
            if (!input.signal.aborted)
              await input.checkpointMessages(messages, context, undefined, change)
            await config.agentOptions?.hooks?.onCheckpoint?.(messages, change)
          },
          onStepFinish: async (step, response, messages, change) => {
            if (!input.signal.aborted) {
              await input.checkpointMessages(messages, context, undefined, change)
            }
            await config.agentOptions?.hooks?.onStepFinish?.(step, response, messages, change)
          },
          getPendingMessages: async () => {
            if (input.signal.aborted) return []
            const pending = await input.getPendingMessages()
            return input.signal.aborted ? [] : toLoopMessages(pending)
          },
          waitForPendingMessages: input.waitForPendingMessages,
          hasPendingInput: input.peekPendingInput,
          isOwnerMessage: (message) =>
            isWrittenByPerson(message) && !("sent_from" in message && message.sent_from === "cli"),
          holdBackgroundCalls: (calls) => input.tools.holdBackground(calls),
          claimBackgroundCalls: (toolCallIds) => input.tools.claimBackground(toolCallIds),
          ...(answerFixInHistory(input.messages, new Set(input.mintedMessageIds)).length > 0
            ? {}
            : {
                checkFinalText: (text: string) =>
                  answerBlockCorrection(text, (callId) => seenToolResult(seenMessages, callId))
              }),
          recoverToolCalls: async (calls) =>
            input.tools.recover(
              await Promise.all(
                calls.map((call) =>
                  durableRequest({
                    toolCallId: call.toolCall.id,
                    name: call.name,
                    args: call.args
                  })
                )
              )
            )
        }
      }
    )

    const output = await config.output?.(input)
    for await (const event of agent.stream(await initialMessages(input, config.systemPrompt), {
      signal: input.signal,
      ...(output === undefined ? {} : { output })
    })) {
      if (!("_tag" in event) && event.stop_reason === "end_turn" && !input.signal.aborted) {
        const last = event.messages.at(-1)
        if (
          last?.role === ROLE.tool ||
          (last?.role === ROLE.assistant && (last.tool_calls?.length ?? 0) === 0)
        ) {
          await input.checkpointMessages(event.messages, context, last.message_id)
        }
      }
      yield event
    }
  }
