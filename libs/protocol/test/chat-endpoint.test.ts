import { Effect } from "effect"
import { expect, it } from "vitest"

import {
  CHAT_ENDPOINT_MIN_WINDOW,
  modelEndpointDecoders,
  modelEndpointRequests,
  modelEndpointRoutes,
  type ChatEndpointCheck,
  type ChatEndpointDraft,
  type ChatModelEndpoint,
  type ModelEndpoints
} from "@arden-hq/protocol/model-endpoints"
import {
  chatEndpointCheckResponse,
  chatEndpointSaveResponse,
  decodeChatEndpointDraftEffect,
  modelEndpointsResponse
} from "@arden-hq/protocol/effect/model-endpoints"

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const saved: ChatModelEndpoint = {
  kind: "chat",
  id: "7d1c2f0e-5b1a-4c0e-9a51-2f7b9c3d4e10",
  service: "llama.cpp",
  baseUrl: "http://127.0.0.1:8080/v1",
  host: "127.0.0.1:8080",
  group: "llama.cpp",
  auth: { kind: "none" },
  models: [{ id: "gemma-4", contextWindow: 32_768, imageInput: true }],
  skipped: [
    { id: "tiny", reason: "window_too_small", window: 16_384 },
    { id: "plain", reason: "no_tool_calls" }
  ],
  health: {
    state: "failing",
    reason: "unreachable",
    since: "2026-11-16T10:00:00.000Z",
    message: "The endpoint stopped answering"
  }
}

it("carries every Check state of a model server through the wire unchanged", () => {
  const checks: ReadonlyArray<ChatEndpointCheck> = [
    {
      result: "works",
      host: "127.0.0.1:8080",
      group: "llama.cpp",
      models: saved.models,
      skipped: saved.skipped,
      ms: 412
    },
    { result: "unreachable", message: "cannot reach http://127.0.0.1:8080/props" },
    { result: "key_refused", message: "HTTP 401" },
    { result: "wrong_format", message: "not chat completions" },
    { result: "address_refused", issue: "insecure", message: "a key over plain HTTP" },
    { result: "no_tool_calls", model: "plain", message: "no tools" },
    {
      result: "window_too_small",
      model: "tiny",
      window: 16_384,
      needed: CHAT_ENDPOINT_MIN_WINDOW,
      message: "small"
    },
    { result: "window_unknown", model: "unloaded", message: "unknown" },
    { result: "model_missing", model: null, message: "lists no model" },
    { result: "model_missing", model: "vendor/none", message: "not on OpenRouter" },
    { result: "model_taken", model: "openai-codex/gpt-6", message: "taken" }
  ]
  for (const check of checks)
    expect(modelEndpointDecoders.chatCheck(wire(chatEndpointCheckResponse(check)))).toEqual(check)
  expect(
    modelEndpointDecoders.chatSave(
      wire(chatEndpointSaveResponse({ result: "saved", endpoint: saved }))
    )
  ).toEqual({ result: "saved", endpoint: saved })
  const openRouter: ChatModelEndpoint = {
    ...saved,
    id: "b2",
    service: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    host: "openrouter.ai",
    group: "OpenRouter",
    auth: { kind: "bearer" },
    models: [
      { id: "openai/gpt-6-luna", contextWindow: 400_000, imageInput: true },
      { id: "anthropic/claude-haiku-5.5", contextWindow: 200_000, imageInput: true }
    ],
    skipped: [],
    health: { state: "works" }
  }
  for (const chat of [[], [saved, openRouter]]) {
    const endpoints: ModelEndpoints = { search: null, decision: null, chat }
    expect(modelEndpointDecoders.endpoints(wire(modelEndpointsResponse(endpoints)))).toEqual(
      endpoints
    )
  }
})

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
  // llama.cpp offers what it lists: a named model is not part of its draft.
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
  // A named server names at least one model, and each once: each is one id in the model list.
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
