import type { ToolCall } from "../contracts/messages.js"
import type { PendingToolCall, ToolArgumentError, ToolDisplayTitle } from "../contracts/tools.js"
import { sanitizeToolDisplayTitle, splitToolArguments } from "./display-title.js"
import { errorMessage } from "@arden-hq/std/errors"
import { isRecord } from "@arden-hq/std/json"
import { parseJsonText } from "@arden-hq/std/json-text"

const invalidArguments = (message: string): ToolArgumentError => ({
  code: "invalid_tool_arguments",
  message
})

const malformedJsonMessage = (source: string, cause: unknown): string => {
  const detail = errorMessage(cause)
  return (
    `Malformed JSON at character ${malformedJsonPosition(source, detail)}: ${normalizedJsonError(detail)}. ` +
    "Retry the tool call with one valid JSON object matching its schema."
  )
}

const expectsPropertyName = /(?:property name|property\s+name|expected ['"]?\})/i

const malformedJsonPosition = (source: string, detail: string): number => {
  const explicitPosition = /position\s+(\d+)/i.exec(detail)?.[1]
  if (explicitPosition !== undefined) return Number(explicitPosition)
  if (/(?:unexpected\s+(?:eof|end)|unexpected end)/i.test(detail)) return source.length
  if (expectsPropertyName.test(detail)) {
    return Math.max(0, Math.max(source.lastIndexOf(","), source.lastIndexOf("{")) + 1)
  }
  return 0
}

const normalizedJsonError = (detail: string): string => {
  if (expectsPropertyName.test(detail)) return "Expecting property name enclosed in double quotes"
  if (/(?:unexpected\s+(?:eof|end))/i.test(detail)) return "Expecting value"
  return detail.replace(/\s+at position\s+\d+.*$/i, "")
}

const nonObjectArguments = (): ToolArgumentError =>
  invalidArguments(
    "Tool arguments must be a JSON object. Retry the tool call with one valid JSON object matching its schema."
  )

const rejected = (toolCall: ToolCall, argumentError: ToolArgumentError): PendingToolCall => ({
  toolCall,
  name: toolCall.function.name,
  args: {},
  argumentError
})

export const parseToolCalls = (
  calls: ReadonlyArray<ToolCall>,
  displayTitleArgument: ToolDisplayTitle | undefined
): ReadonlyArray<PendingToolCall> =>
  calls.map((toolCall) => {
    if (toolCall.function.arguments.length === 0) {
      const displayTitle =
        displayTitleArgument === undefined
          ? undefined
          : sanitizeToolDisplayTitle(toolCall.display_title, displayTitleArgument)
      return {
        toolCall,
        name: toolCall.function.name,
        args: {},
        ...(displayTitle === undefined ? {} : { displayTitle })
      }
    }
    let decoded: unknown
    try {
      decoded = parseJsonText(toolCall.function.arguments)
    } catch (cause) {
      return rejected(
        toolCall,
        invalidArguments(malformedJsonMessage(toolCall.function.arguments, cause))
      )
    }
    if (!isRecord(decoded)) {
      return rejected(toolCall, nonObjectArguments())
    }
    const projected = splitToolArguments(decoded, toolCall.display_title, displayTitleArgument)
    return {
      toolCall,
      name: toolCall.function.name,
      args: projected.args,
      ...(projected.displayTitle === undefined ? {} : { displayTitle: projected.displayTitle })
    }
  })

const visibleToolList = (visibleNames: ReadonlyArray<string>): string => {
  if (visibleNames.length === 0) return "none"
  return visibleNames.length <= 10
    ? visibleNames.join(", ")
    : `${visibleNames.slice(0, 10).join(", ")}, ... (${visibleNames.length} tools total)`
}

export const gateUnavailableCalls = (
  calls: ReadonlyArray<PendingToolCall>,
  advertisedNames: ReadonlySet<string>,
  visibleNames: ReadonlyArray<string>
): ReadonlyArray<PendingToolCall> => {
  const visible = visibleToolList(visibleNames)
  return calls.map((call) =>
    call.argumentError !== undefined || advertisedNames.has(call.name)
      ? call
      : {
          ...call,
          argumentError: {
            code: "unavailable_tool" as const,
            message: `Tool '${call.name}' is not available in this step: it is not in the current tool list. Use one of: ${visible}.`
          }
        }
  )
}
