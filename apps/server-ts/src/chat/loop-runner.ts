import {
  isHumanMessage,
  makeAgent,
  pendingBackgroundCalls,
  resolveModelCapabilities,
  ToolChoice,
  usageInputTokens
} from "@arden-hq/loop"
import type {
  AgentStreamEvent,
  AgentConfigInput,
  AgentHooks,
  AgentOptions,
  AgentOutputOptions,
  ChatMessage,
  ImageInputLimits,
  MessageIdMinter,
  ModelRequest,
  ModelRequestMiddleware,
  ModelRequestNext,
  ModelProvider,
  Toolset,
  ToolCallRequest,
  ToolResult
} from "@arden-hq/loop"
import type {
  ChatRunner,
  ChatRunnerContextReport,
  ChatRunnerInput,
  ChatRunnerMessage,
  ChatRunnerToolRequest,
  ServerToolRun
} from "./runner-contract.js"
import { projectCurrentIdleGap } from "../context/idle-gap.js"
import { projectAnswerBlocks } from "../context/answer-blocks.js"
import { ToolEffectSchema } from "../execution/tool-effect.js"
import { Option, Schema } from "effect"
import { persistToolCallHost } from "../execution/tool-call-presentation.js"
import { observeModelRequests, type CompletedModelRequest } from "./request-observation.js"
import { makeModelRequestMeter, responseUsage } from "./model-request-meter.js"
import { randomUUID } from "node:crypto"
import { appendDeveloperContext } from "./developer-context.js"
import {
  makeLocalInstructionRuntime,
  type LocalInstructionLoader,
  type LocalInstructionRecorder
} from "./local-instruction-runtime.js"
import type { AutomationId } from "../persistence/automations/model.js"
import { mintedMessageId, mintedTurnRoot } from "../persistence/transcript/minted-ids.js"
import { repairOrphanToolOutputs, type OrphanToolOutput } from "./tool-history-repair.js"
import { answerBlockCorrection } from "./ui-blocks.js"
import { answerFixInHistory } from "./loop-events.js"
import { labelToolResults, seenToolResult } from "../context/tool-result-ids.js"
import {
  presentedRuntimeState,
  runtimeUpdate,
  type RuntimeContext
} from "../context/runtime-update.js"
import { currentIso } from "../runtime/clock.js"
import { TODO_REMINDER_SOURCE, todoReminderDue } from "../context/todo-reminder.js"
import {
  OWNER_INSTRUCTIONS_SOURCE,
  ownerInstructionsDue,
  renderOwnerInstructions
} from "../context/owner-instructions.js"

type LoopChatRunnerAgentOptions = Omit<AgentOptions, "provider" | "toolset" | "hooks"> & {
  readonly hooks?: Omit<
    AgentHooks,
    "getPendingMessages" | "hasPendingInput" | "waitForPendingMessages" | "recoverToolCalls"
  >
}

export type LoopChatCompactionResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "replacement"; readonly messages: ReadonlyArray<ChatRunnerMessage> }
  | { readonly kind: "disabled_for_run" }

export interface LoopChatRunnerOptions {
  readonly provider: ModelProvider
  /** Successful final request shape, including resolved tool declarations and search. */
  readonly onRequestComplete?: (input: CompletedModelRequest) => void
  readonly toolset:
    | Toolset
    | ((input: {
        readonly sessionId: string
        readonly runId: string
        readonly approvalMode: ChatRunnerInput["approvalMode"]
        readonly automationId: AutomationId | null
        readonly executeTool: ChatRunnerInput["tools"]["execute"]
        readonly executeDetachedTool: ChatRunnerInput["tools"]["executeDetached"]
        readonly spawnAgent: ChatRunnerInput["tools"]["spawnAgent"]
        readonly cancelAgent: ChatRunnerInput["tools"]["cancelAgent"]
        readonly sendMessage: ChatRunnerInput["tools"]["sendMessage"]
        readonly detachedRun: ChatRunnerInput["tools"]["detachedRun"]
        readonly emitToolProgress: ChatRunnerInput["tools"]["emitToolProgress"]
        readonly emitToolOutput: ChatRunnerInput["tools"]["emitToolOutput"]
        readonly declareEffectTarget: ChatRunnerInput["tools"]["declareEffectTarget"]
        readonly modelUsage: NonNullable<ServerToolRun["modelUsage"]>
        readonly imageInput?: ImageInputLimits
      }) => Toolset | PromiseLike<Toolset>)
  readonly config?: Omit<
    AgentConfigInput,
    "model" | "reasoningEffort" | "toolCallMiddlewares" | "mintMessageId"
  >
  /** A thunk so a setting that changes it takes effect on the NEXT RUN rather
   *  than the next process. Resolved once per run, before the first request. */
  readonly systemPrompt?: string | (() => string | PromiseLike<string>)
  /** Small clock updates, separate from the larger runtime context. */
  readonly localTime?: () => string
  /** The chat's own todo list as a reminder, or undefined when there is none
   *  to keep in view (`context/todo-reminder.ts`); read only when one is due. */
  readonly todoReminder?: (input: {
    readonly sessionId: string
    readonly signal: AbortSignal
  }) => PromiseLike<string | undefined>
  /** Per-user-turn context. The first record restates it whole; later ones
   *  append only what changed (`context/runtime-update.ts`). */
  readonly systemContext?: (input: {
    readonly sessionId: string
    readonly runId: string
    readonly automationId: AutomationId | null
    readonly messages: ReadonlyArray<ChatRunnerMessage>
    readonly signal: AbortSignal
  }) => PromiseLike<RuntimeContext | undefined>
  readonly localInstructions?: LocalInstructionLoader
  readonly recordLocalInstructions?: LocalInstructionRecorder
  readonly output?: (input: ChatRunnerInput) => Promise<AgentOutputOptions | undefined>
  /** Deferred tools a conversation starts with loaded, decided per run. */
  readonly preloadTools?: (input: {
    readonly sessionId: string
    readonly runId: string
    readonly automationId: AutomationId | null
  }) => PromiseLike<ReadonlyArray<string>>
  readonly agentOptions?: LoopChatRunnerAgentOptions
  /** Replace the complete model history at a durable compaction boundary.
   *  System messages in a replacement are ignored: the current system prefix
   *  is kept and the replacement's non-system messages follow it. */
  /** Told once per run and call when a request carried a tool output whose
   *  call is gone from the history; the request sends it as a context note. */
  readonly onOrphanToolOutputs?: (input: {
    readonly sessionId: string
    readonly runId: string
    readonly orphans: ReadonlyArray<OrphanToolOutput>
  }) => void
  readonly compact?: (input: {
    readonly sessionId: string
    readonly runId: string
    readonly model: string
    readonly reasoningEffort: string | null
    readonly messages: ReadonlyArray<ChatRunnerMessage>
    readonly inputTokens: number | null
    readonly pendingCallIds: ReadonlySet<string>
    readonly signal: AbortSignal
  }) => PromiseLike<LoopChatCompactionResult>
}

const toLoopMessages = (messages: ReadonlyArray<ChatRunnerMessage>): ReadonlyArray<ChatMessage> =>
  messages.map((message) => ({ ...message }))

const initialMessages = async (
  input: ChatRunnerInput,
  systemPrompt: LoopChatRunnerOptions["systemPrompt"]
): Promise<ReadonlyArray<ChatMessage>> => {
  const resolved = typeof systemPrompt === "function" ? await systemPrompt() : systemPrompt
  return [
    ...(resolved === undefined ? [] : [{ role: "system" as const, content: resolved }]),
    ...toLoopMessages(input.messages)
  ]
}

const tokenCount = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0

const previousInputTokens = (request: ModelRequest): number | null => {
  const usage = request.previousResponse?.usage
  return usage === undefined
    ? null
    : tokenCount(usage.prompt_tokens) +
        tokenCount(usage.cache_read_tokens) +
        tokenCount(usage.cache_write_tokens)
}

const withStableSystemPrefix = (
  current: ReadonlyArray<ChatMessage>,
  replacement: ReadonlyArray<ChatMessage>
): ReadonlyArray<ChatMessage> => {
  const firstNonSystem = current.findIndex((message) => message.role !== "system")
  const prefix = firstNonSystem < 0 ? current : current.slice(0, firstNonSystem)
  return [...prefix, ...replacement.filter((message) => message.role !== "system")]
}

type CompactionState = "active" | "disabled_for_run"

const makeCompactionMiddleware = (
  compact: NonNullable<LoopChatRunnerOptions["compact"]>,
  input: ChatRunnerInput
): ModelRequestMiddleware => {
  let state: CompactionState = "active"
  return async (request: ModelRequest, next: ModelRequestNext) => {
    const prepared = await next(request)
    if (state === "disabled_for_run") return prepared
    const pending = pendingBackgroundCalls(prepared.messages)
    const result = await compact({
      sessionId: input.sessionId,
      runId: input.runId,
      model: prepared.model,
      reasoningEffort: prepared.reasoningEffort ?? input.reasoningEffort,
      messages: toLoopMessages(prepared.messages),
      inputTokens: previousInputTokens(prepared),
      pendingCallIds: new Set(pending.map((call) => call.toolCall.id)),
      signal: input.signal
    })
    if (result.kind === "disabled_for_run") {
      state = "disabled_for_run"
      return prepared
    }
    if (result.kind === "unchanged") return prepared
    const compacted = withStableSystemPrefix(prepared.messages, toLoopMessages(result.messages))
    return {
      ...prepared,
      messages: compacted,
      compactionReplacement: compacted
    }
  }
}

const makeMessageIdMinter = (
  assistantMessageId: string,
  messages: ReadonlyArray<ChatRunnerMessage>,
  mintedMessageIds: ReadonlyArray<string>
): MessageIdMinter => {
  const claimed = new Set([
    ...mintedMessageIds,
    ...messages.flatMap((message) =>
      message.role === "assistant" && typeof message.message_id === "string"
        ? [message.message_id]
        : []
    )
  ])
  let offset = 0
  while (claimed.has(mintedTurnRoot(assistantMessageId, offset))) offset += 1
  return (kind, position) =>
    mintedMessageId(mintedTurnRoot(assistantMessageId, position.turn + offset), kind, position)
}

const projectIdleGapMiddleware: ModelRequestMiddleware = async (request, next) => {
  const prepared = await next(request)
  return {
    ...prepared,
    messages: projectCurrentIdleGap(prepared.messages)
  }
}

const projectAnswerBlocksMiddleware: ModelRequestMiddleware = async (request, next) => {
  const prepared = await next(request)
  return { ...prepared, messages: projectAnswerBlocks(prepared.messages) }
}

const labelToolResultsMiddleware: ModelRequestMiddleware = async (request, next) => {
  const prepared = await next(request)
  return { ...prepared, messages: labelToolResults(prepared.messages) }
}

const makeToolHistoryRepairMiddleware = (
  report: LoopChatRunnerOptions["onOrphanToolOutputs"],
  input: ChatRunnerInput
): ModelRequestMiddleware => {
  const reported = new Set<string>()
  return async (request, next) => {
    const prepared = await next(request)
    const repair = repairOrphanToolOutputs(prepared.messages)
    if (repair.orphans.length === 0) return prepared
    const fresh = repair.orphans.filter((orphan) => !reported.has(orphan.callId))
    for (const orphan of fresh) reported.add(orphan.callId)
    if (fresh.length > 0)
      report?.({ sessionId: input.sessionId, runId: input.runId, orphans: fresh })
    return { ...prepared, messages: repair.messages }
  }
}

type StepLimitStage = "far" | "plan" | "save" | "final"

const stepLimitWarnings = (maxSteps: number) => ({
  plan: Math.ceil(maxSteps * 0.25),
  save: Math.ceil(maxSteps * 0.05)
})

const STEP_LIMIT_STAGES: ReadonlyArray<{
  readonly stage: Exclude<StepLimitStage, "far">
  readonly reached: (remaining: number, maxSteps: number) => boolean
  readonly note: (maxSteps: number) => string
}> = [
  {
    stage: "final",
    reached: (remaining) => remaining <= 1,
    note: (maxSteps) =>
      `This is the last step of this run's ${maxSteps}-step limit. Tools are off for this step. Write your final reply now: what is done, what is left, where your work is saved.`
  },
  {
    stage: "save",
    reached: (remaining, maxSteps) => remaining <= stepLimitWarnings(maxSteps).save,
    note: (maxSteps) =>
      `${stepLimitWarnings(maxSteps).save} or fewer steps remain of this run's ${maxSteps}-step limit. Save your progress now (files, Task notes), then write your report.`
  },
  {
    stage: "plan",
    reached: (remaining, maxSteps) => remaining <= stepLimitWarnings(maxSteps).plan,
    note: (maxSteps) =>
      `About ${stepLimitWarnings(maxSteps).plan} steps remain of this run's ${maxSteps}-step limit. Continue the task: keep to the main goal, save progress as you go, and plan how to finish. Do not stop because of this note.`
  }
]

const stepLimitStage = (step: number, maxSteps: number): StepLimitStage =>
  STEP_LIMIT_STAGES.find((entry) => entry.reached(maxSteps - step, maxSteps))?.stage ?? "far"

const stepLimitNote = (stage: StepLimitStage, maxSteps: number): string =>
  STEP_LIMIT_STAGES.find((entry) => entry.stage === stage)?.note(maxSteps) ?? ""

const makeStepLimitMiddleware =
  (input: ChatRunnerInput, maxSteps: number): ModelRequestMiddleware =>
  async (request, next) => {
    const stage = stepLimitStage(request.step, maxSteps)
    const prepared = appendDeveloperContext({
      request: await next(request),
      input,
      source: "step_limit",
      content: stepLimitNote(stage, maxSteps)
    })
    return stage === "final" ? { ...prepared, toolChoice: ToolChoice.NONE } : prepared
  }

const makeTodoReminderMiddleware =
  (
    load: NonNullable<LoopChatRunnerOptions["todoReminder"]>,
    input: ChatRunnerInput
  ): ModelRequestMiddleware =>
  async (request, next) => {
    const prepared = await next(request)
    if (!todoReminderDue(prepared.messages)) return prepared
    const reminder = await load({ sessionId: input.sessionId, signal: input.signal })
    if (reminder === undefined) return prepared
    const messages: ReadonlyArray<ChatMessage> = [
      ...prepared.messages,
      {
        role: "developer",
        message_id: `${input.runId}:context:${TODO_REMINDER_SOURCE}:${randomUUID()}`,
        created_at: currentIso(),
        turn_id: input.turnId,
        is_meta: true,
        arden_context_source: TODO_REMINDER_SOURCE,
        content: reminder
      }
    ]
    return { ...prepared, messages, compactionReplacement: messages }
  }

const ownerInstructionsMiddleware =
  (input: ChatRunnerInput): ModelRequestMiddleware =>
  async (request, next) => {
    const prepared = await next(request)
    if (!ownerInstructionsDue(prepared.messages)) return prepared
    const recital = renderOwnerInstructions(prepared.messages)
    if (recital === undefined) return prepared
    const messages: ReadonlyArray<ChatMessage> = [
      ...prepared.messages,
      {
        role: "developer",
        message_id: `${input.runId}:context:${OWNER_INSTRUCTIONS_SOURCE}:${randomUUID()}`,
        created_at: currentIso(),
        turn_id: input.turnId,
        is_meta: true,
        arden_context_source: OWNER_INSTRUCTIONS_SOURCE,
        content: recital
      }
    ]
    return { ...prepared, messages, compactionReplacement: messages }
  }

const NO_RUNTIME_CONTEXT: RuntimeContext = { sections: [], endNote: undefined }

const isRuntimeRecord = (message: ChatMessage): boolean =>
  message.role === "developer" && message.arden_context_source === "runtime"

const appendRuntimeContext = (
  request: ModelRequest,
  input: ChatRunnerInput,
  context: RuntimeContext
): ModelRequest => {
  const records = request.messages.filter(isRuntimeRecord)
  const update = runtimeUpdate({
    presented: presentedRuntimeState(
      records.map((record) => ({
        update: record.arden_context_update,
        state: record.arden_context_state
      }))
    ),
    current: context,
    endNoteDue: !records.some((record) =>
      record.message_id?.startsWith(`${input.runId}:context:runtime:`)
    )
  })
  if (update === undefined) return request
  const messages: ReadonlyArray<ChatMessage> = [
    ...request.messages,
    {
      role: "developer",
      message_id: `${input.runId}:context:runtime:${randomUUID()}`,
      created_at: currentIso(),
      turn_id: input.turnId,
      is_meta: true,
      arden_context_source: "runtime",
      arden_context_update: update.kind,
      arden_context_state: update.state,
      content: update.text
    }
  ]
  return { ...request, messages, compactionReplacement: messages }
}

const makeSystemContextMiddleware = (
  systemContext: NonNullable<LoopChatRunnerOptions["systemContext"]>,
  input: ChatRunnerInput
): ModelRequestMiddleware => {
  let cacheKey: string | null = null
  let cached: RuntimeContext | undefined
  return async (request: ModelRequest, next: ModelRequestNext) => {
    const prepared = await next(request)
    const messages = toLoopMessages(prepared.messages)
    const userIndex = messages.reduce(
      (last, message, index) => (message.role === "user" ? index : last),
      -1
    )
    const user = userIndex < 0 ? undefined : messages[userIndex]
    const catalogCalls = new Set(
      prepared.messages.flatMap((message) =>
        message.role === "assistant"
          ? (message.tool_calls ?? [])
              .filter(
                (call) =>
                  call.function.name === "skill_create" || call.function.name === "skill_update"
              )
              .map((call) => call.id)
          : []
      )
    )
    const completedCatalogCalls = prepared.messages.flatMap((message) =>
      message.role === "tool" && catalogCalls.has(message.tool_call_id)
        ? [message.tool_call_id]
        : []
    )
    const key = JSON.stringify([userIndex, user?.message_id, user?.content, completedCatalogCalls])
    if (cacheKey !== key) {
      cached = await systemContext({
        sessionId: input.sessionId,
        runId: input.runId,
        automationId: input.automationId,
        messages,
        signal: input.signal
      })
      cacheKey = key
    }
    return appendRuntimeContext(prepared, input, cached ?? NO_RUNTIME_CONTEXT)
  }
}

/** Adapt the public Loop agent to the server's plain AsyncIterable seam. */
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
            input
          })
    if (input.model === null) {
      throw new Error("The Loop Chat runner requires a selected ModelHost model")
    }
    const { imageInput } = await resolveModelCapabilities({
      provider: config.provider,
      model: input.model
    })
    const sourceToolset =
      typeof config.toolset === "function"
        ? await config.toolset({
            sessionId: input.sessionId,
            runId: input.runId,
            approvalMode: input.approvalMode,
            automationId: input.automationId,
            executeTool: input.tools.execute,
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
      request.phase?.("waiting")
      return input.tools.execute(
        await durableRequest(request),
        (context) =>
          operation(
            context?.approval === undefined
              ? request
              : { ...request, approval: { ...context.approval } }
          ),
        request.backgrounded === undefined ? {} : { backgrounded: request.backgrounded }
      )
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
    const maxSteps = config.config?.maxIterations
    const preloadTools = await config.preloadTools?.({
      sessionId: input.sessionId,
      runId: input.runId,
      automationId: input.automationId
    })
    const agent = makeAgent(
      {
        ...config.config,
        model: input.model,
        cacheScope: input.treeRootSessionId,
        modelRequestMiddlewares: [
          meter.middleware,
          makeToolHistoryRepairMiddleware(config.onOrphanToolOutputs, input),
          projectIdleGapMiddleware,
          projectAnswerBlocksMiddleware,
          labelToolResultsMiddleware,
          ownerInstructionsMiddleware(input),
          ...(todoReminder === undefined ? [] : [makeTodoReminderMiddleware(todoReminder, input)]),
          ...(localTime === undefined
            ? []
            : [
                async (request: ModelRequest, next: ModelRequestNext) =>
                  appendDeveloperContext({
                    request: await next(request),
                    input,
                    source: "local_time",
                    content: localTime()
                  })
              ]),
          ...(maxSteps === undefined ? [] : [makeStepLimitMiddleware(input, maxSteps)]),
          ...(config.systemContext === undefined
            ? []
            : [makeSystemContextMiddleware(config.systemContext, input)]),
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
            isHumanMessage(message) && !("sent_from" in message && message.sent_from === "cli"),
          holdBackgroundCalls: (calls) => input.tools.holdBackground(calls),
          claimBackgroundCalls: (toolCallIds) => input.tools.claimBackground(toolCallIds),
          ...(answerFixInHistory(input.messages, input.assistantMessageId).length > 0
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
          last?.role === "tool" ||
          (last?.role === "assistant" && (last.tool_calls?.length ?? 0) === 0)
        ) {
          await input.checkpointMessages(event.messages, context, last.message_id)
        }
      }
      yield event
    }
  }
