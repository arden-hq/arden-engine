import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Option, Schema } from "effect"
import { ChatWriteError } from "../chat/store.js"
import { JsonObjectSchema, type JsonObject } from "../json.js"
import {
  StoredMessageEnvelopeSchema,
  type StoredMessageEnvelope,
  withoutTurnStamp
} from "../transcript/model.js"
import { UNCERTAIN_TOOL_RESULT } from "../tools/store.js"
import { canonicalToolArguments } from "./tool-rows.js"
import type { SettledRunToolExecution } from "./tool-receipts.js"
import { sha256Hex } from "@arden-hq/std/hash"

const RuntimeToolCallsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.NonEmptyString,
    type: Schema.Literal("function"),
    function: Schema.Struct({
      name: Schema.NonEmptyString,
      arguments: Schema.String
    }),
    changes_state: Schema.optionalKey(Schema.Boolean)
  })
)
const decodeOptionalId = Schema.decodeUnknownOption(Schema.NonEmptyString)
const decodeToolArguments = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObjectSchema))
const argumentsEquivalent = Schema.toEquivalence(JsonObjectSchema)
const messageEquivalent = Schema.toEquivalence(StoredMessageEnvelopeSchema)

interface ToolCallPositionBase {
  readonly toolCallId: string
  readonly toolName: string
  readonly changesState: boolean | undefined
  readonly messageIndex: number
}

interface ValidToolCallPosition extends ToolCallPositionBase {
  readonly _tag: "ValidArguments"
  readonly arguments: JsonObject
}

interface InvalidToolCallPosition extends ToolCallPositionBase {
  readonly _tag: "InvalidArguments"
}

type ToolCallPosition = ValidToolCallPosition | InvalidToolCallPosition

interface RecoverToolTranscriptInput {
  readonly operation: "finish" | "fail" | "cancel"
  readonly sessionId: string
  readonly runId: string
  readonly terminalAt: string
  readonly activeMessages: ReadonlyArray<StoredMessageEnvelope>
  readonly executions: ReadonlyArray<SettledRunToolExecution>
}

const error = (
  input: RecoverToolTranscriptInput,
  message: string,
  cause?: unknown
): ChatWriteError =>
  new ChatWriteError({
    operation: input.operation,
    reason: "corrupt",
    message,
    sessionId: input.sessionId,
    runId: input.runId,
    ...(cause === undefined ? {} : { cause })
  })

const recoveryMessageId = (runId: string, toolCallId: string): string =>
  `tool-recovered-${sha256Hex(`${runId}\0${toolCallId}\0tool`)}`

const loadToolCallPositions = Effect.fn("ToolTranscript.loadToolCallPositions")(function* (
  input: RecoverToolTranscriptInput
): Effect.fn.Return<ReadonlyArray<ToolCallPosition>, ChatWriteError> {
  const positions: ToolCallPosition[] = []
  const latestIds = new Set<string>()
  for (const [messageIndex, message] of [...input.activeMessages.entries()].reverse()) {
    if (
      message.role !== ROLE.assistant ||
      message.tool_calls === undefined ||
      message.tool_calls === null
    )
      continue
    const calls = yield* Schema.decodeUnknownEffect(RuntimeToolCallsSchema)(
      message.tool_calls
    ).pipe(
      Effect.mapError((cause) => error(input, "Stored assistant tool calls are corrupt", cause))
    )
    if (calls.length === 0) continue
    const seen = new Set<string>()
    for (const call of calls) {
      if (seen.has(call.id)) {
        return yield* error(input, `Stored assistant tool call id is duplicated: ${call.id}`)
      }
      seen.add(call.id)
      if (latestIds.has(call.id)) continue
      latestIds.add(call.id)
      const common = {
        toolCallId: call.id,
        toolName: call.function.name,
        changesState: call.changes_state,
        messageIndex
      }
      positions.push(
        Option.match(decodeToolArguments(call.function.arguments), {
          onNone: () => ({ ...common, _tag: "InvalidArguments" as const }),
          onSome: (arguments_) => ({
            ...common,
            _tag: "ValidArguments" as const,
            arguments: canonicalToolArguments(call.function.name, arguments_)
          })
        })
      )
    }
  }
  return positions.sort((left, right) => left.messageIndex - right.messageIndex)
})

const messagesByToolCallId = (
  messages: ReadonlyArray<StoredMessageEnvelope>,
  selectId: (message: StoredMessageEnvelope) => Option.Option<string>
): ReadonlyMap<string, ReadonlyArray<StoredMessageEnvelope>> => {
  const grouped = new Map<string, Array<StoredMessageEnvelope>>()
  for (const message of messages) {
    Option.match(selectId(message), {
      onNone: () => undefined,
      onSome: (toolCallId) => {
        const existing = grouped.get(toolCallId)
        if (existing === undefined) grouped.set(toolCallId, [message])
        else existing.push(message)
      }
    })
  }
  return grouped
}

const existingToolOutputs = (
  messages: ReadonlyArray<StoredMessageEnvelope>
): ReadonlyMap<string, ReadonlyArray<StoredMessageEnvelope>> =>
  messagesByToolCallId(messages, (message) =>
    message.role === ROLE.tool ? decodeOptionalId(message.tool_call_id) : Option.none()
  )

const decodeEnvelope = Effect.fn("ToolTranscript.decodeEnvelope")(function* (
  input: RecoverToolTranscriptInput,
  candidate: unknown
): Effect.fn.Return<StoredMessageEnvelope, ChatWriteError> {
  return yield* Schema.decodeUnknownEffect(StoredMessageEnvelopeSchema)(candidate).pipe(
    Effect.mapError((cause) => error(input, "Recovered tool output cannot be stored", cause))
  )
})

const toolOutputEnvelope = (
  input: RecoverToolTranscriptInput,
  execution: SettledRunToolExecution
): Effect.Effect<StoredMessageEnvelope, ChatWriteError> =>
  decodeEnvelope(input, {
    ...(execution.result.message_extras ?? {}),
    message_id: recoveryMessageId(input.runId, execution.toolCallId),
    role: ROLE.tool,
    created_at: execution.endedAt,
    tool_call_id: execution.toolCallId,
    content: execution.result.content,
    ...mediaOf(execution)
  })

const mediaOf = (execution: SettledRunToolExecution) =>
  (execution.result.model_content?.length ?? 0) > 0
    ? { model_content: execution.result.model_content }
    : {}

const missingToolOutputEnvelope = (
  input: RecoverToolTranscriptInput,
  toolCallId: string
): Effect.Effect<StoredMessageEnvelope, ChatWriteError> =>
  decodeEnvelope(input, {
    message_id: recoveryMessageId(input.runId, toolCallId),
    role: ROLE.tool,
    created_at: input.terminalAt,
    tool_call_id: toolCallId,
    content:
      input.operation === "cancel"
        ? "The tool was not executed because the assistant run was cancelled before it started."
        : "The tool was not executed because the assistant run ended before it started."
  })

const validateExistingEnvelope = Effect.fn("ToolTranscript.validateExistingEnvelope")(function* (
  input: RecoverToolTranscriptInput,
  toolCallId: string,
  existing: ReadonlyArray<StoredMessageEnvelope>,
  expected: StoredMessageEnvelope | undefined,
  confirmedOutcome: boolean
): Effect.fn.Return<boolean, ChatWriteError> {
  if (existing.length > 1) {
    return yield* error(input, `Stored tool output is duplicated: ${toolCallId}`)
  }
  const actual = existing[0]
  if (actual === undefined) return false
  if (expected === undefined) return true
  const comparable = {
    ...expected,
    message_id: actual.message_id,
    created_at: actual.created_at
  }
  if (!messageEquivalent(withoutTurnStamp(actual), withoutTurnStamp(comparable))) {
    if (confirmedOutcome && actual.content === UNCERTAIN_TOOL_RESULT.content) {
      return true
    }
    return yield* error(
      input,
      `Stored tool output disagrees with its durable result: ${toolCallId}`
    )
  }
  return true
})

const matchingExecutionForPosition = (
  position: ToolCallPosition,
  execution: SettledRunToolExecution | undefined
): SettledRunToolExecution | undefined => {
  if (execution === undefined || position._tag === "InvalidArguments") return undefined
  if (execution.toolName !== position.toolName) return undefined
  if (!argumentsEquivalent(execution.arguments, position.arguments)) return undefined
  if (position.changesState !== undefined && execution.changesState !== position.changesState) {
    return undefined
  }
  return execution
}

const decodeBackgroundLaunch = Schema.decodeUnknownOption(
  Schema.Struct({
    call_id: Schema.NonEmptyString
  })
)

const recoverBackgroundToolMessages = Effect.fn("ToolTranscript.recoverBackgroundToolMessages")(
  function* (input: RecoverToolTranscriptInput): Effect.fn.Return<
    {
      readonly messages: ReadonlyArray<StoredMessageEnvelope>
      readonly ids: ReadonlySet<string>
    },
    ChatWriteError
  > {
    const ids = new Set<string>()
    const messages: StoredMessageEnvelope[] = []
    for (const message of input.activeMessages) {
      const launch = Option.getOrUndefined(decodeBackgroundLaunch(message.async_tool_launch))
      if (launch === undefined) continue
      if (ids.has(launch.call_id)) return yield* error(input, "Duplicate background tool launch")
      ids.add(launch.call_id)
      const existing = input.activeMessages.filter(
        (item) =>
          item.role === ROLE.tool &&
          item.tool_call_id === launch.call_id &&
          item.async_tool_launch === undefined
      )
      if (existing.length > 0) continue
      const execution = input.executions.find((item) => item.toolCallId === launch.call_id)
      const calls = yield* Effect.forEach(
        input.activeMessages.filter(
          (item) => item.role === ROLE.assistant && Array.isArray(item.tool_calls)
        ),
        (item) =>
          Schema.decodeUnknownEffect(RuntimeToolCallsSchema)(item.tool_calls).pipe(
            Effect.mapError((cause) => error(input, "Stored background call is invalid", cause))
          )
      )
      const call = calls.flat().find((item) => item.id === launch.call_id)
      if (call === undefined) return yield* error(input, "Background launch has no matching call")
      const args = Option.getOrUndefined(decodeToolArguments(call.function.arguments))
      if (
        execution !== undefined &&
        (execution.toolName !== call.function.name ||
          args === undefined ||
          !argumentsEquivalent(
            execution.arguments,
            canonicalToolArguments(call.function.name, args)
          ))
      ) {
        return yield* error(input, "Background tool identity disagrees with its durable execution")
      }
      const content =
        execution?.result.content ??
        "Background execution was interrupted. Its outcome is unavailable; check the target state before retrying."
      messages.push(
        yield* decodeEnvelope(input, {
          ...(execution?.result.message_extras ?? {}),
          message_id: recoveryMessageId(input.runId, launch.call_id),
          role: ROLE.tool,
          tool_call_id: launch.call_id,
          content,
          ...(execution === undefined ? {} : mediaOf(execution)),
          created_at: execution?.endedAt ?? input.terminalAt
        })
      )
    }
    return { messages, ids }
  }
)

export const recoverTerminalToolMessages = Effect.fn("ToolTranscript.recoverTerminalToolMessages")(
  function* (
    stored: RecoverToolTranscriptInput
  ): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ChatWriteError> {
    const input: RecoverToolTranscriptInput = {
      ...stored,
      activeMessages: stored.activeMessages.filter((message) => message.forked_from === undefined)
    }
    const executions = new Map(
      input.executions.map((execution) => [execution.toolCallId, execution])
    )
    if (executions.size !== input.executions.length) {
      return yield* error(input, "Settled tool execution ids are not unique")
    }

    const background = yield* recoverBackgroundToolMessages(input)
    const positions = (yield* loadToolCallPositions(input)).filter(
      (position) => !background.ids.has(position.toolCallId)
    )
    const recovered: StoredMessageEnvelope[] = [...background.messages]
    for (const position of positions) {
      const outputs = existingToolOutputs(input.activeMessages.slice(position.messageIndex + 1))
      const execution = executions.get(position.toolCallId)
      const matchingExecution = matchingExecutionForPosition(position, execution)
      const expected =
        matchingExecution === undefined
          ? undefined
          : yield* toolOutputEnvelope(input, matchingExecution)
      const present = yield* validateExistingEnvelope(
        input,
        position.toolCallId,
        outputs.get(position.toolCallId) ?? [],
        expected,
        execution?.confirmedOutcome === true
      )
      if (present) continue
      if (execution !== undefined && matchingExecution === undefined) {
        return yield* error(
          input,
          `Stored tool call identity disagrees with its durable execution: ${position.toolCallId}`
        )
      }
      recovered.push(expected ?? (yield* missingToolOutputEnvelope(input, position.toolCallId)))
    }
    return recovered
  }
)
