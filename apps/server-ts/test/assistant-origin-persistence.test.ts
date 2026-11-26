import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { AssistantMessage } from "@arden-hq/loop"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { makeResultHistoryProjector } from "../src/chat/result-history.js"
import { toChatRunnerMessages } from "../src/chat/run-driver-support.js"
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
      const column = yield* encodeJson(StoredMessageEnvelopeSchema, envelope)
      const stored = yield* decodeJson(StoredMessageEnvelopeSchema, column)
      return yield* toChatRunnerMessages("session", [stored])
    })
  )
  expect(read).toEqual([{ ...answer, client_id: "answer", created_at: expect.any(String) }])
})
