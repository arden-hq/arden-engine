import type { ProviderMessage } from "../../contracts/provider.js"
import type { InputItem } from "./items.js"
import type { ResponsesPayload } from "./request.js"
import { responseItems } from "./stored-items.js"

export interface ResponseContinuation {
  readonly responseId: string
  readonly properties: string
  readonly input: ReadonlyArray<string>
  readonly pendingInput: ReadonlyArray<InputItem>
}

/** Canonical replay prefix, with locally answered searches still awaiting submission. */
export const responseContinuation = ({
  payload,
  message,
  responseId,
  asyncTools
}: {
  readonly payload: ResponsesPayload
  readonly message: ProviderMessage
  readonly responseId: string
  readonly asyncTools: ReadonlySet<string>
}): ResponseContinuation | undefined => {
  const output = responseItems(
    {
      role: "assistant",
      tool_calls: message.tool_calls ?? [],
      ...(message.provider_state === undefined ? {} : { provider_state: message.provider_state })
    },
    asyncTools
  )
  if (output === undefined) return undefined
  const { input: _, stream: __, ...properties } = payload
  return {
    responseId,
    properties: JSON.stringify(properties),
    input: [...payload.input, ...output].map((item) => JSON.stringify(item)),
    pendingInput: output.filter(
      (item) => item.type === "tool_search_output" && item.execution === "client"
    )
  }
}

/** Compaction, edits, or changed request settings start a new full-input chain. */
export const incrementalInput = (
  payload: ResponsesPayload,
  previous: ResponseContinuation
): ReadonlyArray<InputItem> | undefined => {
  const { input, stream: _, ...properties } = payload
  if (
    JSON.stringify(properties) !== previous.properties ||
    input.length < previous.input.length ||
    previous.input.some((item, index) => item !== JSON.stringify(input[index]))
  )
    return undefined
  return [...previous.pendingInput, ...input.slice(previous.input.length)]
}
