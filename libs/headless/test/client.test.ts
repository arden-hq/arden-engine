import { CANCEL_TARGET } from "@arden-hq/protocol/chat"
import { describe, expect, it } from "vitest"

import { createHeadlessClient, HeadlessTimeoutError } from "../src/index.js"

describe("HeadlessClient", () => {
  it("aborts a pending cancellation request with its caller signal", async () => {
    const controller = new AbortController()
    const client = createHeadlessClient({
      baseUrl: "http://arden.test",
      fetch: async (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
    })
    const cancellation = client.cancel(
      { kind: CANCEL_TARGET.run, runId: "run-1" },
      { signal: controller.signal }
    )
    const reason = new Error("cancellation deadline")
    controller.abort(reason)
    await expect(cancellation).rejects.toBe(reason)
  })

  it("keeps timeout authoritative when an injected fetch ignores AbortSignal", async () => {
    const client = createHeadlessClient({
      baseUrl: "http://arden.test",
      fetch: async (_input, init) => {
        await new Promise((resolve) => {
          init?.signal?.addEventListener("abort", resolve, { once: true })
        })
        return Response.json({
          version: 1,
          run_id: "run-timeout",
          turn_id: "turn-timeout",
          session_id: "session-timeout",
          status: "completed",
          started_at: "2026-08-30T00:00:00.000Z",
          updated_at: "2026-08-30T00:00:01.000Z",
          ended_at: "2026-08-30T00:00:01.000Z",
          stop_reason: { kind: "stated", reason: "end_turn" },
          events: { kind: "through", sequence: 2 },
          model: { kind: "model", model_id: "fixture-model" },
          reasoning: { kind: "default" },
          client: { kind: "client", client_id: "client-timeout" },
          local_instructions: [],
          memory_context: [],
          result: { kind: "none" },
          failure: { kind: "none" }
        })
      }
    })

    await expect(
      client.wait(
        {
          runId: "run-timeout",
          sessionId: "session-timeout",
          clientId: "client-timeout",
          status: "running"
        },
        { timeoutMs: 5 }
      )
    ).rejects.toBeInstanceOf(HeadlessTimeoutError)
  })

  it("follows a queued message into the running Run that another client started", async () => {
    const client = createHeadlessClient({
      baseUrl: "http://arden.test",
      fetch: async () =>
        Response.json({
          version: 1,
          run_id: "run-goal",
          turn_id: "turn-goal",
          session_id: "session-goal",
          status: "completed",
          started_at: "2026-10-05T00:00:00.000Z",
          updated_at: "2026-10-05T00:00:01.000Z",
          ended_at: "2026-10-05T00:00:01.000Z",
          stop_reason: { kind: "stated", reason: "end_turn" },
          events: { kind: "through", sequence: 2 },
          model: { kind: "model", model_id: "fixture-model" },
          reasoning: { kind: "default" },
          client: { kind: "client", client_id: "focus:goal:run-before" },
          local_instructions: [],
          memory_context: [],
          result: { kind: "none" },
          failure: { kind: "none" }
        })
    })
    const detail = await client.wait({
      runId: "run-goal",
      sessionId: "session-goal",
      clientId: "typed-message",
      status: "queued"
    })
    expect({ run: detail.run_id, status: detail.status }).toEqual({
      run: "run-goal",
      status: "completed"
    })
  })

  it("lists the server's models by provider, with the ids a new chat takes", async () => {
    const client = createHeadlessClient({
      baseUrl: "http://arden.test",
      fetch: async () =>
        Response.json({
          models: ["gemma-4", "qwen3"],
          names: { "gemma-4": "gemma-4", qwen3: "qwen3" },
          groups: [{ provider: "llama.cpp", label: "llama.cpp", models: ["gemma-4", "qwen3"] }],
          reasoning_efforts: { "gemma-4": ["none", "medium"] }
        })
    })
    expect(await client.listModels()).toEqual({
      providers: [
        {
          id: "llama.cpp",
          name: "llama.cpp",
          models: [
            { id: "gemma-4", name: "gemma-4", reasoningEfforts: ["none", "medium"] },
            { id: "qwen3", name: "qwen3", reasoningEfforts: [] }
          ]
        }
      ]
    })
  })
})
