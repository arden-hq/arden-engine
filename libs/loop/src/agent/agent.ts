import type { ToolSearchStrategy } from "../tools/search.js"
import { abortError, isAbortError, raceAbort } from "../abort.js"
import { validateAgentConfig, type AgentConfig, type AgentConfigInput } from "./config.js"
import {
  AgentCallbackError,
  AgentInvariantError,
  InvalidAgentConfigError,
  LoopError
} from "../errors.js"
import type { ChatMessage, JsonObject, Metadata } from "../contracts/messages.js"
import type { Toolset } from "../contracts/tools.js"
import type { CompletionResponse, ModelProvider } from "../contracts/provider.js"
import type { AgentHooks, AgentStreamEvent, Result, RunBudget } from "../contracts/events.js"
import { EventQueue } from "../internal/stream.js"
import { guardBudget, guardToolset } from "./guards.js"
import { runLoop } from "./run.js"
import type { AgentCostGetter, AgentWiring, Emit } from "./run-state.js"
import type { AgentOutputOptions } from "./structured-output.js"
import { errorMessage } from "@arden-hq/std/errors"

const NODE_ENVIRONMENT = { production: "production" } as const
type NodeEnvironment = (typeof NODE_ENVIRONMENT)[keyof typeof NODE_ENVIRONMENT]
const isProduction = (value: string | undefined): value is NodeEnvironment =>
  value === NODE_ENVIRONMENT.production

export interface AgentOptions {
  readonly provider: ModelProvider
  readonly toolset: Toolset
  readonly hooks?: AgentHooks
  readonly budget?: RunBudget
  readonly costCalculator?: (response: CompletionResponse) => number
  readonly costGetter?: AgentCostGetter
  readonly clock?: () => number
  readonly persistHost?: (host: Metadata) => JsonObject
  readonly toolSearchStrategy?: ToolSearchStrategy
  readonly preloadTools?: ReadonlyArray<string>
}

export interface AgentInvocationOptions {
  readonly signal?: AbortSignal
  readonly output?: AgentOutputOptions
}

export interface Agent {
  readonly config: AgentConfig
  readonly stream: (
    messages: ReadonlyArray<ChatMessage>,
    options?: AgentInvocationOptions
  ) => AsyncIterable<AgentStreamEvent>
  readonly run: (
    messages: ReadonlyArray<ChatMessage>,
    options?: AgentInvocationOptions
  ) => Promise<Result>
}

const monotonicNow = (): number => performance.now()

const deepFreeze = (value: unknown): void => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item)
}

const isResult = (event: AgentStreamEvent): event is Result =>
  !Object.prototype.hasOwnProperty.call(event, "_tag") && "stop_reason" in event

export const makeAgent = (input: AgentConfigInput, options: AgentOptions): Agent => {
  if (options?.provider === undefined || options?.toolset === undefined) {
    throw new TypeError("makeAgent requires provider and toolset")
  }
  const config = validateAgentConfig(input)
  if (
    config.maxCost !== undefined &&
    options.costCalculator === undefined &&
    options.costGetter === undefined
  ) {
    throw new InvalidAgentConfigError("maxCost requires costCalculator or costGetter")
  }
  const wiring: AgentWiring = {
    config,
    provider: options.provider,
    toolset: guardToolset(options.toolset),
    hooks: options.hooks ?? {},
    ...(options.budget === undefined ? {} : { budget: guardBudget(options.budget) }),
    ...(options.costCalculator === undefined ? {} : { costCalculator: options.costCalculator }),
    ...(options.costGetter === undefined ? {} : { costGetter: options.costGetter }),
    clock: options.clock ?? monotonicNow,
    ...(options.persistHost === undefined ? {} : { persistHost: options.persistHost }),
    ...(options.toolSearchStrategy === undefined
      ? {}
      : { toolSearchStrategy: options.toolSearchStrategy }),
    ...(options.preloadTools === undefined ? {} : { preloadTools: options.preloadTools })
  }
  const assertImmutable = !isProduction(process.env.NODE_ENV)

  const stream: Agent["stream"] = (messages, invocationOptions) => {
    const sourceMessages = structuredClone(messages)
    return {
      [Symbol.asyncIterator]() {
        const queue = new EventQueue<AgentStreamEvent>()
        const controller = new AbortController()
        const signal = controller.signal
        const callerSignal = invocationOptions?.signal
        const forwardAbort = () => controller.abort()
        if (callerSignal?.aborted) forwardAbort()
        else callerSignal?.addEventListener("abort", forwardAbort, { once: true })
        const cleanup = () => callerSignal?.removeEventListener("abort", forwardAbort)
        const emit: Emit = (event) => {
          if (assertImmutable && "_tag" in event) deepFreeze(event)
          return raceAbort(queue.push(event), signal)
        }
        const tryEmit = (event: AgentStreamEvent): boolean => {
          if (assertImmutable && "_tag" in event) deepFreeze(event)
          return queue.tryPush(event)
        }
        let started = false
        const start = () => {
          started = true
          const execute = async () => {
            const session = await wiring.provider.openSession?.()
            try {
              await runLoop(
                session === undefined
                  ? wiring
                  : { ...wiring, provider: { ...wiring.provider, stream: session.stream } },
                sourceMessages,
                emit,
                signal,
                invocationOptions?.output,
                tryEmit
              )
            } finally {
              await session?.close()
            }
          }
          const running =
            wiring.provider.openSession === undefined
              ? runLoop(wiring, sourceMessages, emit, signal, invocationOptions?.output, tryEmit)
              : execute()
          void running.then(
            () => queue.end(),
            (cause) => {
              if (isAbortError(cause) || signal.aborted) queue.fail(abortError())
              else if (cause instanceof LoopError) queue.fail(cause)
              else {
                queue.fail(new AgentCallbackError("runtime", errorMessage(cause), cause))
              }
            }
          )
        }
        return {
          async next(): Promise<IteratorResult<AgentStreamEvent>> {
            if (!started) start()
            try {
              const next = await raceAbort(queue.next(), signal)
              if (next.done) cleanup()
              return next
            } catch (cause) {
              controller.abort()
              cleanup()
              throw cause
            }
          },
          async return(value?: unknown): Promise<IteratorResult<AgentStreamEvent>> {
            controller.abort()
            cleanup()
            return { done: true, value: value as never }
          },
          async throw(error: unknown): Promise<IteratorResult<AgentStreamEvent>> {
            controller.abort()
            cleanup()
            throw error
          }
        }
      }
    }
  }

  const run: Agent["run"] = async (messages, invocationOptions) => {
    let terminal: Result | null = null
    for await (const event of stream(messages, invocationOptions)) {
      if (isResult(event)) terminal = event
    }
    if (terminal !== null) return terminal
    if (invocationOptions?.signal?.aborted) throw abortError()
    throw new AgentInvariantError("agent stream ended without a Result")
  }

  return Object.freeze({
    config,
    stream,
    run
  })
}
