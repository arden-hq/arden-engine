import {
  failedToolResult,
  ToolExecutionError,
  type ToolCallRequest,
  type ToolResult
} from "@arden-hq/loop"
import type { ManagedOutputWriter } from "../artifacts/managed-output/managed-output.js"
import type { ToolsetMiddleware } from "../execution/toolset-middleware.js"

export const localizeOutputs = (options: {
  readonly outputs: Pick<ManagedOutputWriter, "localizeToolResult">
  readonly sessionId: string
  readonly onResult?: (request: ToolCallRequest, result: ToolResult) => void
}): ToolsetMiddleware => {
  const localize = (request: ToolCallRequest, result: ToolResult): Promise<ToolResult> =>
    options.outputs.localizeToolResult({
      sessionId: options.sessionId,
      result,
      source: { kind: "tool", name: request.name, call_id: request.toolCallId }
    })
  return {
    execute: async (request, next) => {
      let result: ToolResult
      try {
        result = await next(request)
      } catch (cause) {
        if (!(cause instanceof ToolExecutionError)) throw cause
        const failure = failedToolResult(cause)
        const localized = await localize(request, failure)
        if (localized === failure) throw cause
        return localized
      }
      options.onResult?.(request, result)
      return localize(request, result)
    }
  }
}
