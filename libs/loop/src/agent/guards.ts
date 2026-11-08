import { validateBudgetSnapshot } from "./budget.js"
import type { MaybePromise } from "../contracts/messages.js"
import type { ToolEntry, ToolMeta, Toolset } from "../contracts/tools.js"
import type { RunBudget } from "../contracts/events.js"
import { AgentCallbackError, HookError, ToolsetError } from "../errors.js"
import { errorMessage } from "@arden-hq/std/errors"

export const callbackFailure = (operation: string, cause: unknown): AgentCallbackError =>
  new AgentCallbackError(operation, `${operation} failed: ${errorMessage(cause)}`, cause)

export const invoke = <A>(operation: string, body: () => A): A => {
  try {
    return body()
  } catch (cause) {
    throw callbackFailure(operation, cause)
  }
}

export const hookCall = async <A>(hook: string, body: () => MaybePromise<A>): Promise<A> => {
  try {
    return await body()
  } catch (cause) {
    throw new HookError(hook, `${hook} failed: ${errorMessage(cause)}`, cause)
  }
}

const toolsetFailure = (operation: string, cause: unknown): ToolsetError =>
  new ToolsetError(`${operation} failed: ${errorMessage(cause)}`, cause)

export const guardToolset = (toolset: Toolset): Toolset => {
  const metadata = toolset.metadata
  const seedLoadedNames = toolset.seedLoadedNames
  const decorateResult = toolset.decorateResult
  const settleRefusal = toolset.settleRefusal
  return {
    ...(toolset.displayTitle === undefined ? {} : { displayTitle: toolset.displayTitle }),
    entries: async (): Promise<ReadonlyArray<ToolEntry>> => {
      try {
        const items = await toolset.entries()
        if (!Array.isArray(items)) throw new TypeError("toolset.entries must return an array")
        for (const entry of items) {
          const candidate = entry as ToolEntry | null
          if (typeof candidate?.meta?.name !== "string")
            throw new TypeError("toolset entries must carry meta.name")
          if (
            typeof candidate.description !== "string" ||
            typeof candidate.parameters !== "object" ||
            candidate.parameters === null
          ) {
            throw new TypeError(
              `toolset entry ${candidate.meta.name} needs a description and a parameters schema`
            )
          }
        }
        return items
      } catch (cause) {
        throw toolsetFailure("toolset.entries", cause)
      }
    },
    loadedNames: async (): Promise<ReadonlySet<string>> => {
      try {
        const names = new Set(await toolset.loadedNames())
        if ([...names].some((name) => typeof name !== "string")) {
          throw new TypeError("toolset.loadedNames must contain only strings")
        }
        return names
      } catch (cause) {
        throw toolsetFailure("toolset.loadedNames", cause)
      }
    },
    load: async (names: ReadonlySet<string>): Promise<void> => {
      try {
        await toolset.load(new Set(names))
      } catch (cause) {
        throw toolsetFailure("toolset.load", cause)
      }
    },
    ...(metadata === undefined
      ? {}
      : {
          metadata: async (name: string): Promise<ToolMeta | undefined> => {
            try {
              const resolved = await metadata.call(toolset, name)
              if (resolved !== undefined && resolved.name !== name) {
                throw new TypeError(`toolset.metadata returned ${resolved.name} for ${name}`)
              }
              return resolved
            } catch (cause) {
              throw toolsetFailure("toolset.metadata", cause)
            }
          }
        }),
    ...(seedLoadedNames === undefined
      ? {}
      : {
          seedLoadedNames: async (names: ReadonlySet<string>): Promise<void> => {
            try {
              await seedLoadedNames.call(toolset, new Set(names))
            } catch (cause) {
              throw toolsetFailure("toolset.seedLoadedNames", cause)
            }
          }
        }),
    execute: (request) => toolset.execute(request),
    ...(settleRefusal === undefined
      ? {}
      : { settleRefusal: (request, result) => settleRefusal.call(toolset, request, result) }),
    ...(decorateResult === undefined
      ? {}
      : { decorateResult: (request, result) => decorateResult.call(toolset, request, result) })
  }
}

export const guardBudget = (budget: RunBudget): RunBudget => ({
  snapshot: async () => {
    try {
      return validateBudgetSnapshot(await budget.snapshot())
    } catch (cause) {
      throw callbackFailure("budget.snapshot", cause)
    }
  },
  reserveToolCalls: async (count: number, limit?: number) => {
    try {
      const reserved = await budget.reserveToolCalls(count, limit)
      if (typeof reserved !== "boolean")
        throw new TypeError("budget.reserveToolCalls must return a boolean")
      return reserved
    } catch (cause) {
      throw callbackFailure("budget.reserveToolCalls", cause)
    }
  },
  addOutputTokens: async (count: number) => {
    try {
      return validateBudgetSnapshot(await budget.addOutputTokens(count))
    } catch (cause) {
      throw callbackFailure("budget.addOutputTokens", cause)
    }
  }
})
