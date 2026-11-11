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

  it("names what a sent message did, and parks one behind the Run with queue", async () => {
    const calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> =
      []
    const queued = {
      client_id: "later-1",
      message: "after the run",
      images: [],
      enqueued_at: "2026-11-11T00:00:00.000Z"
    }
    const client = createHeadlessClient({
      baseUrl: "http://arden.test",
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname
        const method = init?.method ?? "GET"
        calls.push({
          method,
          path,
          body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined
        })
        if (path === "/chat/message")
          return Response.json({
            run_id: "run-1",
            session_id: "session-1",
            status: "queued",
            delivery: "steered"
          })
        if (path === "/chat/runs")
          return Response.json({
            runs: [
              {
                run_id: "run-1",
                session_id: "session-1",
                status: "running",
                active: true,
                started_at: "2026-11-11T00:00:00.000Z"
              }
            ],
            idle: false
          })
        if (method === "DELETE") return Response.json({ status: "cancelled", client_id: "later-1" })
        if (method === "POST") return Response.json(queued)
        return Response.json({ session_id: "session-1", messages: [queued] })
      }
    })
    // A message sent while a Run is going joins it: the receipt says steered.
    const steered = await client.submit({ sessionId: "session-1", message: "look at this too" })
    expect(steered).toMatchObject({ runId: "run-1", status: "queued", delivery: "steered" })
    // A queued message waits for the Run to end.
    expect(
      await client.queue({ sessionId: "session-1", message: "after the run", clientId: "later-1" })
    ).toEqual(queued)
    expect(await client.listQueued("session-1")).toEqual([queued])
    expect(await client.cancelQueued("session-1", "later-1")).toMatchObject({ clientId: "later-1" })
    expect(await client.listRuns()).toMatchObject({ idle: false, runs: [{ active: true }] })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /chat/message",
      "POST /sessions/session-1/queue",
      "GET /sessions/session-1/queue",
      "DELETE /sessions/session-1/queue/later-1",
      "GET /chat/runs"
    ])
    expect(calls[1]?.body).toMatchObject({ client_id: "later-1", message: "after the run" })
  })
})
