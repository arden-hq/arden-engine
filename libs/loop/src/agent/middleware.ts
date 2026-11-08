import { ModelRequestMiddlewareError, toToolFailure } from "../errors.js"
import type {
  ToolCallMiddleware,
  ToolCallNext,
  ToolCallRequest,
  ToolResult
} from "../contracts/tools.js"
import {
  ToolChoice,
  type ModelRequest,
  type ModelRequestMiddleware
} from "../contracts/provider.js"
import { errorMessage } from "@arden-hq/std/errors"
import { isRecord } from "@arden-hq/std/json"

const toolChoices = new Set<unknown>(Object.values(ToolChoice))

const isDeclarationList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((tool) => isRecord(tool) && typeof tool.name === "string")

const checkModelRequest = (value: unknown): ModelRequest => {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.step) ||
    !Array.isArray(value.messages) ||
    typeof value.model !== "string" ||
    !isDeclarationList(value.tools) ||
    !isDeclarationList(value.deferredTools) ||
    !toolChoices.has(value.toolChoice) ||
    (value.maxOutputTokens !== undefined &&
      (!Number.isInteger(value.maxOutputTokens) || (value.maxOutputTokens as number) < 1)) ||
    (value.reasoningEffort !== undefined && typeof value.reasoningEffort !== "string") ||
    (value.cacheScope !== undefined && typeof value.cacheScope !== "string") ||
    (value.compactionReplacement !== undefined && !Array.isArray(value.compactionReplacement))
  ) {
    throw new ModelRequestMiddlewareError(
      "model request middleware failed: middleware must return a structurally valid model request"
    )
  }
  return value as unknown as ModelRequest
}

export const applyModelRequestMiddlewares = async (
  request: ModelRequest,
  middleware: ReadonlyArray<ModelRequestMiddleware>
): Promise<ModelRequest> => {
  const dispatch = async (index: number, current: ModelRequest): Promise<ModelRequest> => {
    const currentMiddleware = middleware[index]
    if (currentMiddleware === undefined) return current
    try {
      const result = await currentMiddleware(current, async (next) =>
        dispatch(index + 1, checkModelRequest(next))
      )
      return checkModelRequest(result)
    } catch (cause) {
      if (cause instanceof ModelRequestMiddlewareError) throw cause
      throw new ModelRequestMiddlewareError(
        `model request middleware failed: ${errorMessage(cause)}`,
        cause
      )
    }
  }
  return dispatch(0, request)
}

export const applyToolCallMiddleware = async (
  request: ToolCallRequest,
  terminal: ToolCallNext,
  middleware: ReadonlyArray<ToolCallMiddleware>
): Promise<ToolResult> => {
  const dispatch = (index: number, current: ToolCallRequest): Promise<ToolResult> => {
    const currentMiddleware = middleware[index]
    return currentMiddleware === undefined
      ? Promise.resolve(terminal(current))
      : Promise.resolve(
          currentMiddleware(current, (nextRequest) => dispatch(index + 1, nextRequest))
        )
  }
  try {
    return await dispatch(0, request)
  } catch (cause) {
    throw toToolFailure(cause)
  }
}
