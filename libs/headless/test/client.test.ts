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
    const cancellation = client.cancel({ runId: "run-1" }, { signal: controller.signal })
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
          late_result_at: null,
          session_id: "session-timeout",
          status: "completed",
          started_at: "2026-08-30T00:00:00.000Z",
          updated_at: "2026-08-30T00:00:01.000Z",
          ended_at: "2026-08-30T00:00:01.000Z",
          stop_reason: "end_turn",
          last_event_sequence: 2,
          model_id: "fixture-model",
          reasoning_effort: null,
          client_id: "client-timeout",
          result: null,
          error: null
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
          late_result_at: null,
          session_id: "session-goal",
          status: "completed",
          started_at: "2026-10-05T00:00:00.000Z",
          updated_at: "2026-10-05T00:00:01.000Z",
          ended_at: "2026-10-05T00:00:01.000Z",
          stop_reason: "end_turn",
          last_event_sequence: 2,
          model_id: "fixture-model",
          reasoning_effort: null,
          client_id: "focus:goal:run-before",
          result: null,
          error: null
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
})
