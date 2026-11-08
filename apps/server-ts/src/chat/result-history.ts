import type { ChatMessage, Result as LoopResult } from "@arden-hq/loop"
import { Effect, Result, Schema } from "effect"
import {
  StoredMessageEnvelopeSchema,
  type StoredMessageEnvelope
} from "../persistence/transcript/model.js"
import type { ChatRunnerMessage } from "./runner-contract.js"
import type { HistoryChange } from "@arden-hq/loop"
import type { AutomationContextMode } from "@arden-hq/protocol/automations"
import { currentIso } from "../runtime/clock.js"

export class ResultHistoryError extends Schema.TaggedError<ResultHistoryError>()(
  "ResultHistoryError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

interface ResultHistoryProjectorInput {
  readonly initialMessages: ReadonlyArray<StoredMessageEnvelope>
  readonly assistantMessageId: string
  readonly assistantMessagePersisted: boolean
  readonly terminalMessageId: string
  readonly automationContextMode: AutomationContextMode | null
  readonly turnId: string
}

interface ResultHistoryProjector {
  readonly checkpoint: (
    messages: ReadonlyArray<ChatRunnerMessage>
  ) => Effect.Effect<ReadonlyArray<StoredMessageEnvelope>, ResultHistoryError>
  readonly checkpointAppend: (
    change: Extract<HistoryChange, { readonly kind: "append" }>
  ) => Effect.Effect<
    {
      readonly messages: ReadonlyArray<StoredMessageEnvelope>
      readonly count: number
    },
    ResultHistoryError
  >
  readonly result: (
    result: LoopResult
  ) => Effect.Effect<ReadonlyArray<StoredMessageEnvelope>, ResultHistoryError>
}

interface ProjectedMessage {
  readonly raw: ChatRunnerMessage
  readonly envelope: StoredMessageEnvelope
}

const decodeEnvelope = Schema.decodeUnknownResult(StoredMessageEnvelopeSchema)

const hasToolCalls = (message: ChatMessage): boolean =>
  message.role === "assistant" &&
  ((Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
    (Array.isArray(message.provider_tool_calls) && message.provider_tool_calls.length > 0))

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

const isSessionHandoff = (message: ChatMessage): boolean => {
  const compaction = message.compaction
  return (
    typeof compaction === "object" &&
    compaction !== null &&
    "kind" in compaction &&
    compaction.kind === "session_handoff"
  )
}

export const makeResultHistoryProjector = (
  input: ResultHistoryProjectorInput
): ResultHistoryProjector => {
  const knownCreatedAt = new Map<string, string>()
  const initialMessageIds = new Set<string>()
  const automationMessages = new Map<string, StoredMessageEnvelope>()
  let rootSourceId: string | null = null

  for (const message of input.initialMessages) {
    initialMessageIds.add(message.message_id)
    knownCreatedAt.set(message.message_id, message.created_at)
    if (message.role === "user" && message.automation !== undefined) {
      automationMessages.set(message.message_id, message)
    }
  }
  let rootAssigned =
    input.assistantMessagePersisted || initialMessageIds.has(input.assistantMessageId)
  const durablePrefix =
    input.automationContextMode === "fresh"
      ? input.initialMessages.filter((message) => message.turn_id !== input.turnId)
      : []

  let projectedBySource = new Map<string, ProjectedMessage>()
  let projectedHistory: Array<StoredMessageEnvelope> = []
  let projectedRawCount = 0
  let seenIds = new Set<string>()

  const project = (
    source: ReadonlyArray<ChatRunnerMessage>,
    mode: "checkpoint" | "terminal",
    terminalText?: string
  ): Result.Result<ReadonlyArray<StoredMessageEnvelope>, ResultHistoryError> => {
    const timestamp = currentIso()
    const visible = source.filter(
      (message) => message.role !== "system" || automationMessages.has(message.message_id ?? "")
    )
    const lastIndex = visible.length - 1
    const last = visible[lastIndex]
    const terminalIndex =
      last !== undefined &&
      last.role === "assistant" &&
      !hasToolCalls(last) &&
      isNonEmptyString(last.message_id) &&
      !initialMessageIds.has(last.message_id)
        ? lastIndex
        : -1

    const messages: Array<StoredMessageEnvelope> = []
    const ids = new Set<string>()
    const projected = new Map<string, ProjectedMessage>()
    for (const raw of visible) {
      const sourceId = raw.message_id
      if (!isNonEmptyString(sourceId)) {
        return Result.fail(
          new ResultHistoryError({
            message: "Loop history contains a non-system message without a stable message id"
          })
        )
      }

      if (
        !rootAssigned &&
        raw.role === "assistant" &&
        !isSessionHandoff(raw) &&
        !initialMessageIds.has(sourceId)
      ) {
        rootSourceId = sourceId
        rootAssigned = true
      }
      const cached = projectedBySource.get(sourceId)
      const decoded =
        cached !== undefined && cached.raw === raw
          ? Result.succeed(cached.envelope)
          : decodeMessage(raw, sourceId, timestamp)
      if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
      const message = decoded.success
      if (ids.has(message.message_id)) {
        return Result.fail(
          new ResultHistoryError({ message: "Loop history contains duplicate message ids" })
        )
      }
      ids.add(message.message_id)
      knownCreatedAt.set(message.message_id, message.created_at)
      projected.set(sourceId, { raw, envelope: message })
      messages.push(message)
    }
    projectedBySource = projected

    if (terminalIndex < 0 && mode !== "checkpoint" && !ids.has(input.assistantMessageId)) {
      const messageId = rootAssigned ? input.terminalMessageId : input.assistantMessageId
      const synthetic = decodeEnvelope({
        message_id: messageId,
        client_id: messageId,
        role: "assistant",
        created_at: knownCreatedAt.get(messageId) ?? timestamp,
        content: terminalText ?? ""
      })
      if (Result.isFailure(synthetic)) {
        return Result.fail(
          new ResultHistoryError({
            message: "The terminal assistant message cannot be stored as JSON",
            cause: synthetic.failure
          })
        )
      }
      knownCreatedAt.set(synthetic.success.message_id, synthetic.success.created_at)
      messages.push(synthetic.success)
    }
    const all = [...durablePrefix, ...messages]
    if (mode === "checkpoint") {
      projectedHistory = all
      projectedRawCount = source.length
      seenIds = new Set(all.map((message) => message.message_id))
    }
    return Result.succeed(all)
  }

  const append = (
    change: Extract<HistoryChange, { readonly kind: "append" }>
  ): Result.Result<
    {
      readonly messages: ReadonlyArray<StoredMessageEnvelope>
      readonly count: number
    },
    ResultHistoryError
  > => {
    if (change.start !== projectedRawCount) {
      return Result.fail(new ResultHistoryError({ message: "Loop history append cursor changed" }))
    }
    const timestamp = currentIso()
    const added: Array<StoredMessageEnvelope> = []
    const entries: Array<{
      readonly sourceId: string
      readonly raw: ChatRunnerMessage
      readonly message: StoredMessageEnvelope
    }> = []
    const newIds = new Set<string>()
    const previousRootAssigned = rootAssigned
    const previousRootSourceId = rootSourceId
    const fail = (error: ResultHistoryError) => {
      rootAssigned = previousRootAssigned
      rootSourceId = previousRootSourceId
      return Result.fail(error)
    }
    for (const raw of change.messages) {
      if (raw.role === "system" && !automationMessages.has(raw.message_id ?? "")) continue
      const sourceId = raw.message_id
      if (!isNonEmptyString(sourceId)) {
        return fail(
          new ResultHistoryError({
            message: "Loop history contains a non-system message without a stable message id"
          })
        )
      }
      if (
        !rootAssigned &&
        raw.role === "assistant" &&
        !isSessionHandoff(raw) &&
        !initialMessageIds.has(sourceId)
      ) {
        rootSourceId = sourceId
        rootAssigned = true
      }
      const decoded = decodeMessage(raw, sourceId, timestamp)
      if (Result.isFailure(decoded)) return fail(decoded.failure)
      const message = decoded.success
      if (seenIds.has(message.message_id) || newIds.has(message.message_id)) {
        return fail(
          new ResultHistoryError({ message: "Loop history contains duplicate message ids" })
        )
      }
      newIds.add(message.message_id)
      added.push(message)
      entries.push({ sourceId, raw, message })
    }
    for (const { sourceId, raw, message } of entries) {
      seenIds.add(message.message_id)
      knownCreatedAt.set(message.message_id, message.created_at)
      projectedBySource.set(sourceId, { raw, envelope: message })
      projectedHistory.push(message)
    }
    projectedRawCount += change.messages.length
    return Result.succeed({ messages: added, count: projectedHistory.length })
  }

  const decodeMessage = (
    raw: ChatRunnerMessage,
    sourceId: string,
    timestamp: string
  ): Result.Result<StoredMessageEnvelope, ResultHistoryError> => {
    const isRootAssistant = sourceId === rootSourceId
    const messageId = isRootAssistant ? input.assistantMessageId : sourceId
    const storedAutomation = automationMessages.get(sourceId)
    const candidate: Record<string, unknown> = {
      ...(storedAutomation ?? raw),
      ...(isRootAssistant
        ? {
            message_id: input.assistantMessageId,
            client_id: input.assistantMessageId
          }
        : {})
    }
    candidate.created_at =
      knownCreatedAt.get(messageId) ??
      knownCreatedAt.get(sourceId) ??
      (typeof raw.created_at === "string" ? raw.created_at : timestamp)
    return Result.mapError(
      decodeEnvelope(candidate),
      (cause) =>
        new ResultHistoryError({
          message: "Loop history contains a message that cannot be stored as JSON",
          cause
        })
    )
  }

  const run = <Value>(projection: () => Result.Result<Value, ResultHistoryError>) =>
    Effect.suspend(() => Effect.fromResult(projection())).pipe(
      Effect.withSpan("ChatMessage.projectResultHistory")
    )

  return {
    checkpoint: (messages) => run(() => project(messages, "checkpoint")),
    checkpointAppend: (change) => run(() => append(change)),
    result: (result) => run(() => project(result.messages, "terminal", result.text))
  }
}
