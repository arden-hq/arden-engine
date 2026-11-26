import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { Metadata } from "../../contracts/messages.js"
import type { ProviderMessage } from "../../contracts/provider.js"
import { RESPONSE_ITEM_TYPE, TOOL_SEARCH_EXECUTION, type InputItem } from "./items.js"
import type { ResponsesPayload } from "./request.js"
import { responseItems } from "./stored-items.js"

export interface ResponseContinuation {
  readonly responseId: string
  readonly properties: string
  readonly input: ReadonlyArray<string>
  readonly pendingInput: ReadonlyArray<InputItem>
}

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
      role: ROLE.assistant,
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
      (item) =>
        item.type === RESPONSE_ITEM_TYPE.toolSearchOutput &&
        item.execution === TOOL_SEARCH_EXECUTION.client
    )
  }
}

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

export const continuationInput = (
  input: ReadonlyArray<Metadata>,
  previous: ReadonlyArray<Metadata>,
  steered: ReadonlyArray<Metadata>
): ReadonlyArray<Metadata> => {
  const seen = new Map<string, number>()
  for (const item of [...previous, ...steered]) {
    const key = JSON.stringify(item)
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return input.filter((item) => {
    if (item.role !== ROLE.user && item.type !== RESPONSE_ITEM_TYPE.functionCallOutput) return false
    const key = JSON.stringify(item)
    const count = seen.get(key) ?? 0
    if (count === 0) return true
    seen.set(key, count - 1)
    return false
  })
}
