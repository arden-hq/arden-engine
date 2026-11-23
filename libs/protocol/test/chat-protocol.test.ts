import { ROLE } from "@arden-hq/std/message-vocabulary"
import { expect, it } from "vitest"

import { decodeServerEvent } from "@arden-hq/protocol"
import { ProtocolError } from "@arden-hq/protocol"
import {
  CHAT_QUEUE_LIMIT,
  CHAT_REPLY_QUOTES_MAX,
  chatRequests,
  type ChatReplyContext
} from "@arden-hq/protocol/chat"

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
    role: ROLE.assistant,
    content: `Quoted line ${n}`
  })
  const sent = (replyTo: ChatReplyContext | ReadonlyArray<ChatReplyContext>): unknown =>
    JSON.parse(
      chatRequests.message({ sessionId: "chat", clientId: "c1", message: "Compare", replyTo }).body
    ).reply_to
  const wire = (n: number) => ({
    message_id: `answer-${n}`,
    role: ROLE.assistant,
    content: `Quoted line ${n}`
  })

  expect(sent(quote(1))).toEqual([wire(1)])
  expect(sent([quote(1), quote(2)])).toEqual([wire(1), wire(2)])
  expect(() => sent([])).toThrow(ProtocolError)
  expect(() => sent(Array.from({ length: CHAT_REPLY_QUOTES_MAX + 1 }, (_, n) => quote(n)))).toThrow(
    ProtocolError
  )
})
