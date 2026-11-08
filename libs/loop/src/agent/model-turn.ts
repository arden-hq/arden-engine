import { isAbortError, raceAbort } from "../abort.js"
import { InvalidModelResponseError, ModelProviderError } from "../errors.js"
import {
  messageId as newMessageId,
  type AssistantOutputPart,
  type ChatMessage,
  type JsonObject,
  type Metadata,
  type ProviderToolCall,
  type ToolCall
} from "../contracts/messages.js"
import type { ToolDisplayTitle, ToolMeta } from "../contracts/tools.js"
import type {
  CompletionResponse,
  ModelProvider,
  ModelProviderRequest,
  ModelStreamItem
} from "../contracts/provider.js"
import type { AgentEvent } from "../contracts/events.js"
import { parseModelItem, validateCompletion } from "../internal/validate.js"

import {
  assistantMessage,
  fallbackOutputParts,
  persistedToolCall,
  providerCompleted,
  providerStarted,
  startKey,
  type ToolStartEvent,
  type ToolStartSnapshot
} from "./model-output.js"
import { StreamedCallHistory } from "./streamed-call-history.js"
import { ModelOutputProjection } from "./model-output-projection.js"
import { errorMessage } from "@arden-hq/std/errors"

type AgentEventEmitter = (event: AgentEvent) => Promise<void>

export interface ModelTurnInput {
  readonly provider: ModelProvider
  readonly request: ModelProviderRequest
  readonly history: ChatMessage[]
  readonly metas: ReadonlyMap<string, ToolMeta>
  readonly emit: AgentEventEmitter
  readonly displayTitle?: ToolDisplayTitle
  readonly persistHost?: (host: Metadata) => JsonObject
  readonly mintMessageId?: (
    kind: "text" | "reasoning",
    position: { readonly fragment: number; readonly index: number }
  ) => string
  readonly onToolCallReady?: (call: ToolCall, checkpoint: () => Promise<void>) => Promise<void>
  readonly checkpoint?: () => Promise<void>
  readonly commitOutput?: (operation: () => Promise<void>) => Promise<void>
}

export interface ModelTurnOutput {
  readonly response: CompletionResponse
  readonly streamedToolInputIds: ReadonlySet<string>
  readonly lastTextId: string | null
}

interface StreamedToolInput {
  toolId: string | null
  name: string | null
  arguments: string
  started: boolean
  ended: boolean
}

const openProviderStream = async (
  input: ModelTurnInput
): Promise<AsyncIterator<ModelStreamItem>> => {
  let source: Iterable<ModelStreamItem> | AsyncIterable<ModelStreamItem>
  try {
    source = await input.provider.stream(input.request)
  } catch (cause) {
    if (isAbortError(cause)) throw cause
    throw new ModelProviderError(`model provider failed: ${errorMessage(cause)}`, cause)
  }
  if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]()
  return (async function* () {
    yield* source
  })()
}

export const runModelTurn = async (input: ModelTurnInput): Promise<ModelTurnOutput> => {
  const readyCalls = new StreamedCallHistory(input.history)
  const minter = input.mintMessageId
  const mintId = (kind: "text" | "reasoning", index: number): string =>
    minter === undefined ? newMessageId(kind) : minter(kind, { fragment: readyCalls.count, index })
  let response: CompletionResponse | undefined
  const projection = new ModelOutputProjection(input.emit, mintId)
  let streamedToolInputs = new Map<number, StreamedToolInput>()
  let streamedToolInputIds = new Set<string>()
  let streamedProviderToolIds = new Set<string>()
  let completedProviderToolIds = new Set<string>()
  let toolStarts = new Map<string, ToolStartSnapshot>()
  let cutAtCommit = false
  const now = Date.now

  const emitToolStart = async (
    event: ToolStartEvent,
    execution: "runtime" | "provider"
  ): Promise<void> => {
    const timestamp = now()
    const parentId = event.parent_id ?? null
    toolStarts.set(startKey(execution, event.tool_id), {
      timestamp,
      parentId,
      persisted: input.persistHost?.(event.host) ?? {}
    })
    await input.emit({ ...event, timestamp })
  }

  const completeProviderTool = async (call: ProviderToolCall): Promise<void> => {
    if (completedProviderToolIds.has(call.id)) return
    const start = toolStarts.get(startKey("provider", call.id))
    const duration = start === undefined ? 0 : Math.max(0, Math.trunc(now() - start.timestamp))
    await input.emit(providerCompleted(call, input.metas, duration))
    completedProviderToolIds.add(call.id)
  }

  const resetProjection = (): void => {
    projection.beginFragment()
    streamedToolInputs = new Map()
    streamedToolInputIds = new Set(readyCalls.persistedIds)
    streamedProviderToolIds = new Set(readyCalls.providerCalls.keys())
    completedProviderToolIds = new Set(
      [...completedProviderToolIds].filter((id) => readyCalls.providerCalls.has(id))
    )
    toolStarts = new Map(
      [...toolStarts].filter(
        ([key]) =>
          [...readyCalls.persistedIds].some((id) => key === startKey("runtime", id)) ||
          [...readyCalls.providerCalls.keys()].some((id) => key === startKey("provider", id))
      )
    )
  }

  const emitProjectionReset = async (): Promise<void> => {
    await input.emit({
      _tag: "ModelResponseReset",
      depth: 0,
      parent_id: null,
      message_ids: [...projection.messageIds],
      tool_call_ids: [...new Set([...streamedToolInputIds, ...streamedProviderToolIds])]
        .filter((id) => !readyCalls.persistedIds.has(id) && !readyCalls.providerCalls.has(id))
        .sort()
    })
  }

  const toolInput = (index: number): StreamedToolInput => {
    const existing = streamedToolInputs.get(index)
    if (existing !== undefined) return existing
    const created: StreamedToolInput = {
      toolId: null,
      name: null,
      arguments: "",
      started: false,
      ended: false
    }
    streamedToolInputs.set(index, created)
    return created
  }

  const reconcileOutputParts = async (
    parts: ReadonlyArray<AssistantOutputPart>,
    completionResponse: CompletionResponse
  ): Promise<void> => {
    const message = completionResponse.message
    const runtimeCalls = new Map((message.tool_calls ?? []).map((call) => [call.id, call]))
    const providerCalls = new Map(
      (message.provider_tool_calls ?? []).map((call) => [call.id, call])
    )
    if (!projection.canExtend(parts)) {
      await emitProjectionReset()
      resetProjection()
    }
    if (parts.length > 0 && parts.every((part) => part.type === "tool_call")) {
      await projection.ensureText()
      await projection.close()
    }
    for (const [index, part] of parts.entries()) {
      const streamed = projection.parts[index] !== undefined
      switch (part.type) {
        case "reasoning":
        case "text":
          await projection.completePart(part, index)
          break
        case "tool_call": {
          if (!streamed) {
            await projection.close()
            projection.parts.push({ ...part })
          }
          if (part.execution === "provider") {
            const call = providerCalls.get(part.tool_call_id)
            if (call === undefined) {
              throw new InvalidModelResponseError(
                "output_parts references a missing provider tool call"
              )
            }
            if (!streamedProviderToolIds.has(call.id)) {
              streamedProviderToolIds.add(call.id)
              await emitToolStart(providerStarted(call, input.metas), "provider")
            }
            await completeProviderTool(call)
            break
          }
          const call = runtimeCalls.get(part.tool_call_id)
          if (call === undefined) {
            throw new InvalidModelResponseError(
              "output_parts references a missing runtime tool call"
            )
          }
          if (streamedToolInputIds.has(call.id)) {
            const state = [...streamedToolInputs.values()].find((value) => value.toolId === call.id)
            if (state !== undefined && !state.ended) {
              state.ended = true
              await input.emit({
                _tag: "ToolInputEnded",
                depth: 0,
                parent_id: null,
                tool_id: call.id
              })
            }
            break
          }
          streamedToolInputIds.add(call.id)
          await emitToolStart(
            {
              _tag: "ToolInputStarted",
              depth: 0,
              parent_id: null,
              tool_id: call.id,
              name: call.function.name,
              host: { ...(input.metas.get(call.function.name)?.host ?? {}) }
            },
            "runtime"
          )
          if (call.function.arguments.length > 0) {
            await input.emit({
              _tag: "ToolInputDelta",
              depth: 0,
              parent_id: null,
              tool_id: call.id,
              delta: call.function.arguments
            })
          }
          await input.emit({ _tag: "ToolInputEnded", depth: 0, parent_id: null, tool_id: call.id })
          break
        }
      }
    }
  }

  const processItem = async (raw: ModelStreamItem): Promise<void> => {
    const item = parseModelItem(raw)

    switch (item._tag) {
      case "TextDelta":
        await projection.delta("text", item.content)
        return

      case "ReasoningDelta":
        await projection.delta("reasoning", item.content)
        return

      case "ToolCallDelta": {
        const delta = item.delta
        const state = toolInput(delta.index)
        if (delta.tool_id !== null) state.toolId = delta.tool_id
        if (delta.name !== null) state.name = delta.name
        if (delta.arguments_delta !== null) state.arguments += delta.arguments_delta
        if (state.toolId !== null && state.name !== null && !state.started) {
          await projection.close()
          state.started = true
          streamedToolInputIds.add(state.toolId)
          projection.parts.push({
            type: "tool_call",
            tool_call_id: state.toolId,
            execution: "runtime"
          })
          await emitToolStart(
            {
              _tag: "ToolInputStarted",
              depth: 0,
              parent_id: null,
              tool_id: state.toolId,
              name: state.name,
              host: { ...(input.metas.get(state.name)?.host ?? {}) }
            },
            "runtime"
          )
          if (state.arguments.length > 0) {
            await input.emit({
              _tag: "ToolInputDelta",
              depth: 0,
              parent_id: null,
              tool_id: state.toolId,
              delta: state.arguments
            })
          }
        } else if (delta.arguments_delta !== null && state.started && state.toolId !== null) {
          await input.emit({
            _tag: "ToolInputDelta",
            depth: 0,
            parent_id: null,
            tool_id: state.toolId,
            delta: delta.arguments_delta
          })
        }
        if (delta.done && state.started && !state.ended && state.toolId !== null) {
          state.ended = true
          await input.emit({
            _tag: "ToolInputEnded",
            depth: 0,
            parent_id: null,
            tool_id: state.toolId
          })
        }
        return
      }

      case "ProviderToolCall": {
        const call = item.call
        if (!call.done && streamedProviderToolIds.has(call.id)) return
        if (!streamedProviderToolIds.has(call.id)) {
          await projection.close()
          streamedProviderToolIds.add(call.id)
          projection.parts.push({
            type: "tool_call",
            tool_call_id: call.id,
            execution: "provider"
          })
          await emitToolStart(providerStarted(call, input.metas), "provider")
        }
        return
      }

      case "OutputItemReady": {
        const commit = async (): Promise<void> => {
          const fragment: CompletionResponse = {
            _tag: "Completed",
            model: input.request.model,
            finish_reason: "tool_calls",
            usage: { completion_tokens: 0 },
            message: item.message
          }
          for (const call of item.message.tool_calls ?? []) {
            if (readyCalls.calls.has(call.id))
              throw new InvalidModelResponseError("a completed tool call was emitted twice")
            readyCalls.add(call)
          }
          const parts = item.message.output_parts ?? fallbackOutputParts(fragment, projection.parts)
          await reconcileOutputParts(parts, fragment)
          await projection.close()
          readyCalls.persist(
            assistantMessage(
              fragment,
              projection.fragmentId,
              parts.some((part) => part.type === "text") ? projection.fragmentId : null,
              parts,
              toolStarts,
              input.displayTitle
            )
          )
          for (const [index, part] of parts.entries()) {
            const messageId = projection.textMessageIdsByPartIndex.get(index)
            if (part.type !== "text" || part.phase === undefined || messageId === undefined)
              continue
            await input.emit({
              _tag: "TextPhaseResolved",
              depth: 0,
              parent_id: null,
              message_id: messageId,
              phase: part.phase
            })
          }
          projection.beginFragment()
          for (const call of item.message.tool_calls ?? []) {
            await input.onToolCallReady?.(
              persistedToolCall(
                call,
                toolStarts.get(startKey("runtime", call.id)),
                input.displayTitle
              ),
              async () => {
                await input.checkpoint?.()
              }
            )
          }
        }
        await (input.commitOutput === undefined ? commit() : input.commitOutput(commit))
        return
      }

      case "ProviderStreamRetry": {
        if (readyCalls.persisted) {
          if (
            projection.messageIds.size > 0 ||
            [...streamedToolInputIds].some((id) => !readyCalls.persistedIds.has(id)) ||
            [...streamedProviderToolIds].some((id) => !readyCalls.providerCalls.has(id))
          ) {
            await emitProjectionReset()
          }
          resetProjection()
          response = readyCalls.committed(input.request.model)
          cutAtCommit = true
          return
        }
        readyCalls.reset()

        await input.emit({
          _tag: "ModelStreamRetry",
          depth: 0,
          parent_id: null,
          attempt: item.attempt,
          max_attempts: item.maxAttempts
        })
        if (
          projection.messageIds.size > 0 ||
          streamedToolInputIds.size > 0 ||
          streamedProviderToolIds.size > 0
        ) {
          await emitProjectionReset()
        }
        response = undefined
        resetProjection()
        return
      }

      case "Completed": {
        if (response !== undefined) {
          throw new InvalidModelResponseError(
            "model stream emitted more than one CompletionResponse"
          )
        }
        response = item
        return
      }
    }
  }

  const iterator = await openProviderStream(input)
  try {
    while (true) {
      let next: IteratorResult<ModelStreamItem>
      try {
        next = await raceAbort(iterator.next(), input.request.signal)
      } catch (cause) {
        if (isAbortError(cause) || cause instanceof ModelProviderError) throw cause
        throw new ModelProviderError(`model provider stream failed: ${errorMessage(cause)}`, cause)
      }
      if (next.done) break
      await processItem(next.value)
      if (cutAtCommit) {
        void Promise.resolve()
          .then(() => iterator.return?.())
          .catch(() => undefined)
        break
      }
    }
  } catch (cause) {
    await projection.close().catch(() => undefined)
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined)
    throw cause
  }

  if (response === undefined) {
    await projection.close()
    throw new InvalidModelResponseError("model stream ended without a CompletionResponse")
  }
  let validResponse: CompletionResponse
  try {
    validResponse = validateCompletion(response)
  } catch (cause) {
    await projection.close().catch(() => undefined)
    throw cause
  }

  readyCalls.validate(validResponse.message)
  const message = validResponse.message
  const canonicalOutputParts =
    message.output_parts ?? fallbackOutputParts(validResponse, projection.parts)
  if (!readyCalls.persisted) {
    await reconcileOutputParts(canonicalOutputParts, validResponse)
    await projection.ensureText()
  }

  const resolvedTextPhases = (readyCalls.persisted ? [] : canonicalOutputParts).flatMap(
    (part, index) => {
      if (part.type !== "text" || part.phase === undefined) return []
      const messageId = projection.textMessageIdsByPartIndex.get(index)
      if (messageId === undefined) {
        throw new InvalidModelResponseError("text output part is missing its projected message id")
      }
      return [{ messageId, phase: part.phase }]
    }
  )

  readyCalls.finish(
    assistantMessage(
      validResponse,
      projection.fragmentId,
      canonicalOutputParts.some((part) => part.type === "text") ? projection.fragmentId : null,
      canonicalOutputParts,
      toolStarts,
      input.displayTitle
    )
  )
  await projection.close()
  for (const resolved of resolvedTextPhases) {
    await input.emit({
      _tag: "TextPhaseResolved",
      depth: 0,
      parent_id: null,
      message_id: resolved.messageId,
      phase: resolved.phase
    })
  }

  return {
    response: validResponse,
    streamedToolInputIds,
    lastTextId: projection.lastTextId
  }
}
