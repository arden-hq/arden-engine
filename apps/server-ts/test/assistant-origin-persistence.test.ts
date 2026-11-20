import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { AssistantMessage, ProviderMessage } from "@arden-hq/loop"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { makeResultHistoryProjector } from "../src/chat/result-history.js"
import { toChatRunnerMessages } from "../src/chat/run-driver.js"
import { replayedAssistant } from "../src/context/summary-requests.js"
import { decodeJson, encodeJson } from "../src/persistence/sqlite/json.js"
import { StoredMessageEnvelopeSchema } from "../src/persistence/transcript/model.js"

const origin = {
  provider: "llama.cpp",
  api: "chat-completions",
  model: "gemma-32k",
  requested_model: "gemma-32k"
}
const providerState = { "chat-completions": { reasoning: "kept" } }

it("an assistant record keeps its origin and provider state through the transcript and back", async () => {
  const answer: AssistantMessage = {
    role: ROLE.assistant,
    message_id: "answer",
    content: "Done.",
    output_parts: [{ type: "text", text: "Done." }],
    provider_state: providerState,
    origin
  }
  const projector = makeResultHistoryProjector({
    initialMessages: [],
    assistantMessageId: "answer",
    assistantMessagePersisted: false,
    terminalMessageId: "terminal",
    automationContextMode: null,
    turnId: "turn"
  })
  const read = await Effect.runPromise(
    Effect.gen(function* () {
      const [envelope] = yield* projector.checkpoint([answer])
      // What chat-transcript.ts writes to `message_json` and the history reads back.
      const column = yield* encodeJson(StoredMessageEnvelopeSchema, envelope)
      const stored = yield* decodeJson(StoredMessageEnvelopeSchema, column)
      return yield* toChatRunnerMessages("session", [stored])
    })
  )
  expect(read).toEqual([{ ...answer, client_id: "answer", created_at: expect.any(String) }])
})

it("a replayed answer carries every field of the provider's message", () => {
  const message: ProviderMessage = {
    role: ROLE.assistant,
    content: null,
    tool_calls: null,
    reasoning_content: "Thought.",
    provider_tool_calls: null,
    output_parts: [{ type: "reasoning", text: "Thought." }],
    provider_state: providerState,
    origin
  }
  expect(replayedAssistant(message)).toEqual({
    role: ROLE.assistant,
    content: "",
    tool_calls: [],
    output_parts: [{ type: "reasoning", text: "Thought." }],
    reasoning_content: "Thought.",
    provider_state: providerState,
    origin
  })
})
