import { expect, it } from "vitest"
import {
  historyProviderToolCalls,
  historyToolCalls,
  withConversationResult,
  withResultMetadata
} from "../src/chat/history-tool-calls.js"

it("reads a stored call's face with tagged states and settles it from the result ledger", () => {
  const [call] = historyToolCalls([
    {
      id: "call-1",
      function: { name: "read", arguments: '{"path":"a"}' },
      display_title: "a",
      parent_id: "call-0",
      presentation: "conversation"
    }
  ])
  expect(call).toEqual(
    expect.objectContaining({
      name: "read",
      arguments: '{"path":"a"}',
      display_name: "read",
      parent: { kind: "child", parent_id: "call-0" },
      title: { kind: "titled", text: "a" },
      kind: "tool",
      presentation: "conversation",
      execution: "runtime",
      started: { kind: "unrecorded" },
      result: { kind: "unshown" },
      status: { kind: "open" },
      data: { kind: "none" }
    })
  )
  if (call === undefined) return
  const settled = withConversationResult(
    withResultMetadata(call, { isError: false, retryable: null, durationMs: 12, data: { n: 1 } }),
    "done",
    { isError: false, retryable: null, data: { n: 1 } }
  )
  expect(settled).toEqual(
    expect.objectContaining({
      status: {
        kind: "settled",
        is_error: false,
        retry: "unstated",
        duration: { kind: "timed", ms: 12 }
      },
      result: { kind: "shown", text: "done" },
      data: { kind: "attached", value: { n: 1 } },
      gmail_send: { kind: "unconfirmed" }
    })
  )
})

it("carries a provider call's sources as its data", () => {
  expect(
    historyProviderToolCalls([
      { id: "p", name: "web_search", is_error: false, source_refs: [{ url: "u" }] }
    ])
  ).toEqual([
    expect.objectContaining({
      execution: "provider",
      status: {
        kind: "settled",
        is_error: false,
        retry: "unstated",
        duration: { kind: "untimed" }
      },
      data: { kind: "attached", value: { source_refs: [{ url: "u" }] } }
    })
  ])
})
