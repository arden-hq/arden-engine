import { ROLE } from "@arden-hq/std/message-vocabulary"
import { expect, it } from "vitest"
import { makeAgent } from "../src/index.js"

import { makeOpenAiResponsesProvider } from "../src/providers/openai-responses/provider.js"
import { deferred, recordOf, recordsOf } from "./kit.js"
import {
  makeTransport,
  simpleCompleted,
  sseResponse,
  staticAuth,
  type StreamControl
} from "./openai-responses-kit.js"

it("dispatches completed SSE calls before response.completed and replays fragment state exactly once", async () => {
  const started = deferred(),
    control = deferred<StreamControl>()
  const reasoning = {
    id: "reasoning-ready",
    type: "reasoning",
    summary: [],
    encrypted_content: "opaque-reasoning"
  }
  const fn = {
    id: "fn-ready",
    type: "function_call",
    call_id: "ready-call",
    name: "weather",
    arguments: "{}",
    status: "completed"
  }
  const transport = makeTransport([
    () =>
      sseResponse((stream) => {
        stream.send({
          type: "response.output_item.done",
          output_index: 0,
          item: reasoning
        })
        stream.send({
          type: "response.output_item.done",
          output_index: 1,
          item: fn
        })
        control.resolve(stream)
      }),
    () =>
      sseResponse((stream) => {
        stream.send({ type: "response.completed", response: simpleCompleted })
        stream.end()
      })
  ])
  const provider = makeOpenAiResponsesProvider({
    auth: staticAuth,
    fetch: transport.fetchImpl
  })
  let executions = 0
  const agent = makeAgent(
    { model: "gpt-5.4" },
    {
      provider,
      toolset: {
        entries: () => [{ description: "weather", parameters: {}, meta: { name: "weather" } }],
        loadedNames: () => new Set(),
        load: () => {},
        execute: () => {
          executions++
          started.resolve()
          return { content: "sunny", preview: "sunny" }
        }
      }
    }
  )
  const running = agent.run([{ role: ROLE.user, content: "weather" }])
  await started.promise
  expect(executions).toBe(1)
  const stream = await control.promise
  stream.send({
    type: "response.completed",
    response: { id: "ready-response", output: [reasoning, fn] }
  })
  stream.end()
  expect((await running).text).toBe("Recovered.")
  const input = recordsOf(recordOf(transport.requests[1]?.body).input)
  expect(input.filter((item) => item.type === "function_call").map((item) => item.call_id)).toEqual(
    ["ready-call"]
  )
  expect(
    input.filter((item) => item.type === "function_call_output").map((item) => item.call_id)
  ).toEqual(["ready-call"])
  expect(input.filter((item) => item.type === "reasoning")).toEqual([
    expect.objectContaining(reasoning)
  ])
  expect(executions).toBe(1)
})

it.each([false, true, undefined])(
  "settles empty Responses completions with end_turn=%s",
  async (endTurn) => {
    const transport = makeTransport([
      () =>
        sseResponse((control) => {
          control.send({
            type: "response.completed",
            response: {
              id: "empty",
              status: "completed",
              output: [],
              ...(endTurn === undefined ? {} : { end_turn: endTurn })
            }
          })
          control.end()
        }),
      () =>
        sseResponse((control) => {
          control.send({
            type: "response.completed",
            response: simpleCompleted
          })
          control.end()
        })
    ])
    const result = await makeAgent(
      { model: "gpt-5.4" },
      {
        provider: makeOpenAiResponsesProvider({
          auth: staticAuth,
          fetch: transport.fetchImpl
        }),
        toolset: {
          entries: () => [],
          loadedNames: () => new Set(),
          load: () => {},
          execute: () => {
            throw new Error("Unexpected tool")
          }
        }
      }
    ).run([{ role: ROLE.user, content: "Continue" }])
    expect({
      text: result.text,
      stop: result.stop_reason,
      requests: transport.requests.length
    }).toEqual({
      text: endTurn === false ? "Recovered." : "",
      stop: "end_turn",
      requests: endTurn === false ? 2 : 1
    })
  }
)
