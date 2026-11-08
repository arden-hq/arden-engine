import { InvalidAgentConfigError } from "../errors.js"
import type { MessageIdMinter } from "../contracts/messages.js"
import type { ToolCallMiddleware } from "../contracts/tools.js"
import { ToolChoice, type ModelRequestMiddleware } from "../contracts/provider.js"
import type { RunPolicy } from "../contracts/events.js"

const defaultMaxToolConcurrency = 6
const defaultBackgroundGraceMs = 1_000
const defaultForegroundBudgetMs = 10_000

interface AgentLimits {
  readonly maxIterations?: number
  readonly maxToolCalls?: number
  readonly maxWallTimeMs?: number
  readonly maxCost?: number
  /** Consecutive all-error steps before stopping. Zero disables this limit. */
  readonly maxNoProgressSteps: number
}

const defaultAgentLimits: AgentLimits = {
  maxNoProgressSteps: 0
}

/** Input accepted by `validateAgentConfig`; limit fields are flattened for Agent callers. */
export interface AgentConfigInput extends Partial<AgentLimits> {
  readonly model: string
  readonly maxOutputTokens?: number
  readonly toolChoice?: ToolChoice
  readonly reasoningEffort?: string
  /**
   * Stable identity of the conversation a request extends — one value for a
   * whole agent tree. Each provider maps it to its own prompt-cache mechanism
   * (OpenAI: `prompt_cache_key`); the host never deals in cache details.
   */
  readonly cacheScope?: string
  readonly maxToolConcurrency?: number
  /**
   * How long the next model request waits for background calls just launched,
   * so a quick one delivers its result in that request instead of a running
   * receipt and one more request. Zero disables the wait. Defaults to 1000.
   */
  readonly backgroundGraceMs?: number
  /**
   * Execution time after which a call still running moves to the background:
   * the model gets a receipt and the result arrives later. Counted from when
   * the call's effect begins. Defaults to 10000; Infinity keeps every call in
   * the foreground.
   */
  readonly foregroundBudgetMs?: number
  readonly modelRequestMiddlewares?: ReadonlyArray<ModelRequestMiddleware>
  readonly toolCallMiddlewares?: ReadonlyArray<ToolCallMiddleware>
  readonly policy?: RunPolicy
  readonly mintMessageId?: MessageIdMinter
}

/** Immutable, validated configuration consumed by the Agent state machine. */
export interface AgentConfig extends AgentLimits {
  readonly model: string
  readonly maxOutputTokens?: number
  readonly toolChoice: ToolChoice
  readonly maxToolConcurrency: number
  readonly backgroundGraceMs: number
  readonly foregroundBudgetMs: number
  readonly modelRequestMiddlewares: ReadonlyArray<ModelRequestMiddleware>
  readonly toolCallMiddlewares: ReadonlyArray<ToolCallMiddleware>
  readonly policy: RunPolicy
  readonly reasoningEffort?: string
  readonly cacheScope?: string
  readonly mintMessageId?: MessageIdMinter
}

const invalidField = (field: string): InvalidAgentConfigError =>
  new InvalidAgentConfigError(`invalid agent config field: ${field}`)

const optionalNonNegative = (value: number | undefined): boolean =>
  value === undefined || (Number.isFinite(value) && value >= 0)

const optionalNonNegativeInteger = (value: number | undefined): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0)

const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

const validateAgentLimits = (input: Partial<AgentLimits> = {}): AgentLimits => {
  const limits: AgentLimits = { ...defaultAgentLimits, ...input }
  if (
    !optionalNonNegativeInteger(limits.maxIterations) ||
    !optionalNonNegativeInteger(limits.maxToolCalls) ||
    !optionalNonNegative(limits.maxWallTimeMs) ||
    !optionalNonNegative(limits.maxCost) ||
    !optionalNonNegativeInteger(limits.maxNoProgressSteps)
  ) {
    throw new InvalidAgentConfigError(
      "iteration, tool-call, and no-progress limits must be non-negative integers; wall-time and cost limits must be finite non-negative values"
    )
  }
  return limits
}

const copyPolicy = (policy: RunPolicy | undefined): RunPolicy => {
  const source = policy ?? {}
  return Object.freeze({
    ...(source.finalizeInstruction === undefined
      ? {}
      : { finalizeInstruction: source.finalizeInstruction }),
    ...(source.fallbackResultText === undefined
      ? {}
      : { fallbackResultText: source.fallbackResultText }),
    ...(source.budgetDenialContent === undefined
      ? {}
      : { budgetDenialContent: source.budgetDenialContent })
  })
}

const toolChoices = new Set<unknown>(Object.values(ToolChoice))

const limitInput = (input: AgentConfigInput): Partial<AgentLimits> => ({
  ...(input.maxIterations === undefined ? {} : { maxIterations: input.maxIterations }),
  ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
  ...(input.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: input.maxWallTimeMs }),
  ...(input.maxCost === undefined ? {} : { maxCost: input.maxCost }),
  ...(input.maxNoProgressSteps === undefined
    ? {}
    : { maxNoProgressSteps: input.maxNoProgressSteps })
})

export const validateAgentConfig = (input: AgentConfigInput): AgentConfig => {
  if (typeof input.model !== "string" || input.model.length === 0) throw invalidField("model")
  if (input.maxOutputTokens !== undefined && !positiveInteger(input.maxOutputTokens)) {
    throw invalidField("maxOutputTokens")
  }
  const limits = validateAgentLimits(limitInput(input))
  const toolChoice = input.toolChoice === undefined ? ToolChoice.AUTO : input.toolChoice
  if (!toolChoices.has(toolChoice)) throw invalidField("toolChoice")
  const maxToolConcurrency =
    input.maxToolConcurrency === undefined ? defaultMaxToolConcurrency : input.maxToolConcurrency
  if (!positiveInteger(maxToolConcurrency)) throw invalidField("maxToolConcurrency")
  const backgroundGraceMs = input.backgroundGraceMs ?? defaultBackgroundGraceMs
  if (!optionalNonNegative(backgroundGraceMs)) throw invalidField("backgroundGraceMs")
  const foregroundBudgetMs = input.foregroundBudgetMs ?? defaultForegroundBudgetMs
  if (Number.isNaN(foregroundBudgetMs) || foregroundBudgetMs < 0)
    throw invalidField("foregroundBudgetMs")
  if (input.reasoningEffort !== undefined && typeof input.reasoningEffort !== "string") {
    throw invalidField("reasoningEffort")
  }
  if (input.cacheScope !== undefined && typeof input.cacheScope !== "string") {
    throw invalidField("cacheScope")
  }
  if (
    input.modelRequestMiddlewares !== undefined &&
    !Array.isArray(input.modelRequestMiddlewares)
  ) {
    throw invalidField("modelRequestMiddlewares")
  }
  if (input.toolCallMiddlewares !== undefined && !Array.isArray(input.toolCallMiddlewares)) {
    throw invalidField("toolCallMiddlewares")
  }
  if (input.mintMessageId !== undefined && typeof input.mintMessageId !== "function") {
    throw invalidField("mintMessageId")
  }

  return Object.freeze({
    model: input.model,
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    ...limits,
    toolChoice,
    maxToolConcurrency,
    backgroundGraceMs,
    foregroundBudgetMs,
    modelRequestMiddlewares: Object.freeze([...(input.modelRequestMiddlewares ?? [])]),
    toolCallMiddlewares: Object.freeze([...(input.toolCallMiddlewares ?? [])]),
    policy: copyPolicy(input.policy),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.cacheScope === undefined ? {} : { cacheScope: input.cacheScope }),
    ...(input.mintMessageId === undefined ? {} : { mintMessageId: input.mintMessageId })
  })
}
