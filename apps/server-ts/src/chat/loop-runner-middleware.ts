import { SKILL_CREATE_TOOL_NAME, SKILL_UPDATE_TOOL_NAME } from "../skills/guard.js"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { pendingBackgroundCalls, ToolChoice } from "@arden-hq/loop"
import type {
  ChatMessage,
  MessageIdMinter,
  ModelRequest,
  ModelRequestMiddleware,
  ModelRequestNext
} from "@arden-hq/loop"
import type { ChatRunnerInput, ChatRunnerMessage } from "./runner-contract.js"
import { projectCurrentIdleGap } from "../context/idle-gap.js"
import { projectAnswerBlocks } from "../context/answer-blocks.js"
import { randomUUID } from "node:crypto"
import { appendDeveloperContext, DEVELOPER_CONTEXT_SOURCE } from "./developer-context.js"
import { mintedMessageId, mintedTurnRoot } from "../persistence/transcript/minted-ids.js"
import { repairOrphanToolOutputs } from "./tool-history-repair.js"
import { labelToolResults } from "../context/tool-result-ids.js"
import {
  isRuntimeContextSource,
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
import { LOOP_COMPACTION_RESULT, type LoopChatRunnerOptions } from "./loop-runner-options.js"

export const toLoopMessages = (
  messages: ReadonlyArray<ChatRunnerMessage>
): ReadonlyArray<ChatMessage> => messages.map((message) => ({ ...message }))

export const initialMessages = async (
  input: ChatRunnerInput,
  systemPrompt: LoopChatRunnerOptions["systemPrompt"]
): Promise<ReadonlyArray<ChatMessage>> => {
  const resolved = typeof systemPrompt === "function" ? await systemPrompt() : systemPrompt
  return [
    ...(resolved === undefined ? [] : [{ role: ROLE.system, content: resolved }]),
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
  const firstNonSystem = current.findIndex((message) => message.role !== ROLE.system)
  const prefix = firstNonSystem < 0 ? current : current.slice(0, firstNonSystem)
  return [...prefix, ...replacement.filter((message) => message.role !== ROLE.system)]
}

export const makeCompactionMiddleware = (
  compact: NonNullable<LoopChatRunnerOptions["compact"]>,
  input: ChatRunnerInput
): ModelRequestMiddleware => {
  let disabled = false
  return async (request: ModelRequest, next: ModelRequestNext) => {
    const prepared = await next(request)
    if (disabled) return prepared
    const pending = pendingBackgroundCalls(prepared.messages)
    const result = await compact({
      sessionId: input.sessionId,
      runId: input.runId,
      model: prepared.model,
      reasoningEffort: prepared.reasoningEffort ?? input.reasoningEffort,
      messages: toLoopMessages(prepared.messages),
      inputTokens: previousInputTokens(prepared),
      overflow: prepared.contextOverflow === true,
      pendingCallIds: new Set(pending.map((call) => call.toolCall.id)),
      signal: input.signal
    })
    if (result.kind === LOOP_COMPACTION_RESULT.disabledForRun) {
      disabled = true
      return prepared
    }
    if (result.kind === LOOP_COMPACTION_RESULT.unchanged) return prepared
    const compacted = withStableSystemPrefix(prepared.messages, toLoopMessages(result.messages))
    const { contextOverflow: _, ...answered } = prepared
    return {
      ...answered,
      messages: compacted,
      compactionReplacement: compacted
    }
  }
}

export const makeMessageIdMinter = (
  assistantMessageId: string,
  messages: ReadonlyArray<ChatRunnerMessage>,
  mintedMessageIds: ReadonlyArray<string>
): MessageIdMinter => {
  const claimed = new Set([
    ...mintedMessageIds,
    ...messages.flatMap((message) =>
      message.role === ROLE.assistant && typeof message.message_id === "string"
        ? [message.message_id]
        : []
    )
  ])
  let offset = 0
  while (claimed.has(mintedTurnRoot(assistantMessageId, offset))) offset += 1
  return (kind, position) =>
    mintedMessageId(mintedTurnRoot(assistantMessageId, position.turn + offset), kind, position)
}

export const projectIdleGapMiddleware: ModelRequestMiddleware = async (request, next) => {
  const prepared = await next(request)
  return {
    ...prepared,
    messages: projectCurrentIdleGap(prepared.messages)
  }
}

export const projectAnswerBlocksMiddleware: ModelRequestMiddleware = async (request, next) => {
  const prepared = await next(request)
  return { ...prepared, messages: projectAnswerBlocks(prepared.messages) }
}

export const labelToolResultsMiddleware: ModelRequestMiddleware = async (request, next) => {
  const prepared = await next(request)
  return { ...prepared, messages: labelToolResults(prepared.messages) }
}

export const makeToolHistoryRepairMiddleware = (
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

const STEP_LIMIT_STAGE = { far: "far", plan: "plan", save: "save", final: "final" } as const

type StepLimitStage = (typeof STEP_LIMIT_STAGE)[keyof typeof STEP_LIMIT_STAGE]

const stepLimitWarnings = (maxSteps: number) => ({
  plan: Math.ceil(maxSteps * 0.25),
  save: Math.ceil(maxSteps * 0.05)
})

const STEP_LIMIT_STAGES: ReadonlyArray<{
  readonly stage: Exclude<StepLimitStage, typeof STEP_LIMIT_STAGE.far>
  readonly reached: (remaining: number, maxSteps: number) => boolean
  readonly note: (maxSteps: number) => string
}> = [
  {
    stage: STEP_LIMIT_STAGE.final,
    reached: (remaining) => remaining <= 1,
    note: (maxSteps) =>
      `This is the last step of this run's ${maxSteps}-step limit. Tools are off for this step. Write your final reply now: what is done, what is left, where your work is saved.`
  },
  {
    stage: STEP_LIMIT_STAGE.save,
    reached: (remaining, maxSteps) => remaining <= stepLimitWarnings(maxSteps).save,
    note: (maxSteps) =>
      `${stepLimitWarnings(maxSteps).save} or fewer steps remain of this run's ${maxSteps}-step limit. Save your progress now (files, Task notes), then write your report.`
  },
  {
    stage: STEP_LIMIT_STAGE.plan,
    reached: (remaining, maxSteps) => remaining <= stepLimitWarnings(maxSteps).plan,
    note: (maxSteps) =>
      `About ${stepLimitWarnings(maxSteps).plan} steps remain of this run's ${maxSteps}-step limit. Continue the task: keep to the main goal, save progress as you go, and plan how to finish. Do not stop because of this note.`
  }
]

const stepLimitStage = (step: number, maxSteps: number): StepLimitStage =>
  STEP_LIMIT_STAGES.find((entry) => entry.reached(maxSteps - step, maxSteps))?.stage ??
  STEP_LIMIT_STAGE.far

const stepLimitNote = (stage: StepLimitStage, maxSteps: number): string =>
  STEP_LIMIT_STAGES.find((entry) => entry.stage === stage)?.note(maxSteps) ?? ""

export const makeStepLimitMiddleware =
  (input: ChatRunnerInput, maxSteps: number): ModelRequestMiddleware =>
  async (request, next) => {
    const stage = stepLimitStage(request.step, maxSteps)
    const prepared = appendDeveloperContext({
      request: await next(request),
      input,
      source: DEVELOPER_CONTEXT_SOURCE.stepLimit,
      content: stepLimitNote(stage, maxSteps)
    })
    return stage === STEP_LIMIT_STAGE.final
      ? { ...prepared, toolChoice: ToolChoice.NONE }
      : prepared
  }

export const makeTodoReminderMiddleware =
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
        role: ROLE.developer,
        message_id: `${input.runId}:context:${TODO_REMINDER_SOURCE}:${randomUUID()}`,
        created_at: currentIso(),
        turn_id: input.turnId,
        arden_context_source: TODO_REMINDER_SOURCE,
        content: reminder
      }
    ]
    return { ...prepared, messages, compactionReplacement: messages }
  }

export const ownerInstructionsMiddleware =
  (
    load: NonNullable<LoopChatRunnerOptions["ownerWords"]>,
    input: ChatRunnerInput
  ): ModelRequestMiddleware =>
  async (request, next) => {
    const prepared = await next(request)
    if (!ownerInstructionsDue(prepared.messages)) return prepared
    const owned = await load({
      sessionId: input.sessionId,
      messageIds: prepared.messages.flatMap((message) =>
        message.role === ROLE.user && typeof message.message_id === "string"
          ? [message.message_id]
          : []
      ),
      signal: input.signal
    })
    const recital = renderOwnerInstructions(prepared.messages, owned)
    if (recital === undefined) return prepared
    const messages: ReadonlyArray<ChatMessage> = [
      ...prepared.messages,
      {
        role: ROLE.developer,
        message_id: `${input.runId}:context:${OWNER_INSTRUCTIONS_SOURCE}:${randomUUID()}`,
        created_at: currentIso(),
        turn_id: input.turnId,
        arden_context_source: OWNER_INSTRUCTIONS_SOURCE,
        content: recital
      }
    ]
    return { ...prepared, messages, compactionReplacement: messages }
  }

const NO_RUNTIME_CONTEXT: RuntimeContext = { sections: [], endNote: undefined }

const isRuntimeRecord = (message: ChatMessage): boolean =>
  message.role === ROLE.developer && isRuntimeContextSource(message.arden_context_source)

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
    endNoteDue: !records.some((record) => record.arden_context_run_id === input.runId)
  })
  if (update === undefined) return request
  const messages: ReadonlyArray<ChatMessage> = [
    ...request.messages,
    {
      role: ROLE.developer,
      message_id: `${input.runId}:context:runtime:${randomUUID()}`,
      created_at: currentIso(),
      turn_id: input.turnId,
      arden_context_source: "runtime",
      arden_context_run_id: input.runId,
      arden_context_update: update.kind,
      arden_context_state: update.state,
      content: update.text
    }
  ]
  return { ...request, messages, compactionReplacement: messages }
}

export const makeSystemContextMiddleware = (
  systemContext: NonNullable<LoopChatRunnerOptions["systemContext"]>,
  input: ChatRunnerInput,
  directionReviews: () => number
): ModelRequestMiddleware => {
  let cacheKey: string | null = null
  let cached: RuntimeContext | undefined
  return async (request: ModelRequest, next: ModelRequestNext) => {
    const prepared = await next(request)
    const messages = toLoopMessages(prepared.messages)
    const userIndex = messages.reduce(
      (last, message, index) =>
        message.role === ROLE.user || message.role === ROLE.interaction ? index : last,
      -1
    )
    const user = userIndex < 0 ? undefined : messages[userIndex]
    const catalogCalls = new Set(
      prepared.messages.flatMap((message) =>
        message.role === ROLE.assistant
          ? (message.tool_calls ?? [])
              .filter(
                (call) =>
                  call.function.name === SKILL_CREATE_TOOL_NAME ||
                  call.function.name === SKILL_UPDATE_TOOL_NAME
              )
              .map((call) => call.id)
          : []
      )
    )
    const completedCatalogCalls = prepared.messages.flatMap((message) =>
      message.role === ROLE.tool && catalogCalls.has(message.tool_call_id)
        ? [message.tool_call_id]
        : []
    )
    const key = JSON.stringify([
      userIndex,
      user?.message_id,
      user?.content,
      completedCatalogCalls,
      directionReviews()
    ])
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
