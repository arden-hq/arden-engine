import { Effect } from "effect"
import { expect, it } from "vitest"

import {
  modelEndpointRequests,
  modelEndpointRoutes,
  type ChatEndpointDraft
} from "@arden-hq/protocol/model-endpoints"
import { decodeChatEndpointDraftEffect } from "@arden-hq/protocol/effect/model-endpoints"

it("sends a model server draft as the server reads it, and never a key it was not given", async () => {
  const drafts: ReadonlyArray<ChatEndpointDraft> = [
    { service: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", auth: { kind: "none" } },
    {
      service: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      models: ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"],
      auth: { kind: "bearer", apiKey: "sk-or-test" }
    },
    {
      service: "custom",
      baseUrl: "https://models.example.com/v1",
      models: ["served"],
      auth: { kind: "keep" }
    }
  ]
  for (const draft of drafts) {
    const body = modelEndpointRequests.chatDraft(draft)
    expect(await Effect.runPromise(decodeChatEndpointDraftEffect(JSON.parse(body)))).toEqual(draft)
  }
  await expect(
    Effect.runPromise(
      decodeChatEndpointDraftEffect({
        service: "llama.cpp",
        base_url: "http://127.0.0.1:8080/v1",
        model: "gemma",
        auth: { kind: "none" }
      })
    )
  ).rejects.toThrow()
  for (const models of [[], ["a", "a"]])
    await expect(
      Effect.runPromise(
        decodeChatEndpointDraftEffect({
          service: "openrouter",
          base_url: "https://openrouter.ai/api/v1",
          models,
          auth: { kind: "none" }
        })
      )
    ).rejects.toThrow()
})

it("builds each model server's route from its id, and refuses an id that is not one", () => {
  expect(modelEndpointRoutes.chatServer("b2")).toBe("/model-endpoints/chat/b2")
  expect(modelEndpointRoutes.chatServerCheck("b2")).toBe("/model-endpoints/chat/b2/check")
  expect(() => modelEndpointRoutes.chatServer("../search")).toThrow()
  expect(() => modelEndpointRoutes.chatServer("check")).toThrow()
})
