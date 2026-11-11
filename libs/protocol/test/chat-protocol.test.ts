import { expect, it } from "vitest"

import { decodeServerEvent } from "@arden-hq/protocol"
import { ProtocolError } from "@arden-hq/protocol"
import {
  CHAT_QUEUE_LIMIT,
  CHAT_REPLY_QUOTES_MAX,
  chatRequests,
  type ChatReplyContext,
  type ChatRunErrorCode
} from "@arden-hq/protocol/chat"

it("keeps delta streams lossy and terminal events authoritative", () => {
  expect(
    decodeServerEvent({
      type: "TEXT_MESSAGE_END",
      message_id: "assistant-1",
      content: "The corrected final text"
    })
  ).toMatchObject({ content: "The corrected final text" })
  expect(
    decodeServerEvent({
      type: "TEXT_MESSAGE_END",
      message_id: "assistant-1"
    })
  ).toEqual({ type: "TEXT_MESSAGE_END", message_id: "assistant-1" })
  expect(
    decodeServerEvent({
      type: "REASONING_MESSAGE_END",
      message_id: "reasoning-1",
      content: "Weighing both options"
    })
  ).toMatchObject({ content: "Weighing both options" })
  expect(
    decodeServerEvent({
      type: "REASONING_MESSAGE_END",
      message_id: "reasoning-1"
    })
  ).toEqual({ type: "REASONING_MESSAGE_END", message_id: "reasoning-1" })
  expect(
    decodeServerEvent({
      type: "TOOL_CALL_RESULT",
      tool_call_id: "tool-1",
      name: "bash",
      content: "complete output"
    })
  ).toMatchObject({ content: "complete output" })
  expect(
    decodeServerEvent({
      type: "TOOL_CALL_PROGRESS",
      tool_call_id: "tool-1",
      message: "Running"
    })
  ).toMatchObject({ message: "Running" })
})

it("carries a bounded reconnect on stream_retry without ending the turn", () => {
  expect(
    decodeServerEvent({
      type: "stream_retry",
      run_id: "run-1",
      attempt: 2,
      max_attempts: 5
    })
  ).toEqual({ type: "stream_retry", run_id: "run-1", attempt: 2, max_attempts: 5 })
  expect(() =>
    decodeServerEvent({
      type: "stream_retry",
      run_id: "run-1",
      attempt: 2
    })
  ).toThrow(ProtocolError)
  expect(() =>
    decodeServerEvent({
      type: "stream_retry",
      run_id: "run-1",
      attempt: 1.5,
      max_attempts: 5
    })
  ).toThrow(ProtocolError)
})

it("keeps RUN_ERROR on the closed run-failure taxonomy", () => {
  const codes = [
    "context_length_exceeded",
    "rate_limited",
    "provider_auth",
    "provider_unavailable",
    "provider_error",
    "request_invalid",
    "tool_persistence_failed",
    "run_interrupted",
    "runner_error"
  ] as const satisfies ReadonlyArray<ChatRunErrorCode>
  for (const code of codes) {
    expect(
      decodeServerEvent({
        type: "RUN_ERROR",
        run_id: "run-1",
        turn_id: "turn-1",
        message: "failed",
        code
      })
    ).toMatchObject({ code })
  }
  expect(() =>
    decodeServerEvent({
      type: "RUN_ERROR",
      run_id: "run-1",
      turn_id: "turn-1",
      message: "failed",
      code: "provider_exploded"
    })
  ).toThrow(ProtocolError)
  expect(
    decodeServerEvent({
      type: "RUN_ERROR",
      run_id: "run-1",
      turn_id: "turn-1",
      message: "failed"
    })
  ).toEqual({ type: "RUN_ERROR", run_id: "run-1", turn_id: "turn-1", message: "failed" })
})

it("encodes queue order without reordering identities and rejects ambiguous membership", () => {
  expect(
    JSON.parse(
      chatRequests.reorderQueue({ sessionId: "chat", clientIds: ["third", "first", "second"] })
    )
  ).toEqual({ client_ids: ["third", "first", "second"] })
  for (const clientIds of [
    ["same", "same"],
    [""],
    Array.from({ length: CHAT_QUEUE_LIMIT + 1 }, (_, i) => String(i))
  ]) {
    expect(() => chatRequests.reorderQueue({ sessionId: "chat", clientIds })).toThrow(ProtocolError)
  }
})

it("sends the quoted messages of a reply as a list, one or several, up to the limit", () => {
  const quote = (n: number): ChatReplyContext => ({
    messageId: `answer-${n}`,
    role: "assistant",
    content: `Quoted line ${n}`
  })
  const sent = (replyTo: ChatReplyContext | ReadonlyArray<ChatReplyContext>): unknown =>
    JSON.parse(
      chatRequests.message({ sessionId: "chat", clientId: "c1", message: "Compare", replyTo }).body
    ).reply_to
  const wire = (n: number) => ({
    message_id: `answer-${n}`,
    role: "assistant",
    content: `Quoted line ${n}`
  })

  expect(sent(quote(1))).toEqual([wire(1)])
  expect(sent([quote(1), quote(2)])).toEqual([wire(1), wire(2)])
  expect(() => sent([])).toThrow(ProtocolError)
  expect(() => sent(Array.from({ length: CHAT_REPLY_QUOTES_MAX + 1 }, (_, n) => quote(n)))).toThrow(
    ProtocolError
  )
})
