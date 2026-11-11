import { describe, expect, it } from "vitest"

import {
  makeAgent,
  providerErrorCode,
  type ModelProvider,
  type ModelProviderRequest,
  type ModelRequestMiddleware,
  type ModelStreamItem
} from "../src/index.js"
import { SemanticResponseError } from "../src/providers/kit/errors.js"
import { scriptedProvider } from "./kit.js"

const response = (content: string, finishReason: "stop" | "length" = "stop") => ({
  model: "test-model",
  _tag: "Completed" as const,
  message: {
    role: "assistant" as const,
    content,
    tool_calls: [],
    reasoning_content: null
  },
  finish_reason: finishReason,
  usage: { prompt_tokens: 9, completion_tokens: 1 }
})

const emptyToolset = {
  entries: () => [],
  loadedNames: () => new Set<string>(),
  load: () => undefined,
  execute: () => ({ content: "", preview: "" })
}

const contents = (request: ModelProviderRequest | undefined) =>
  (request?.messages ?? []).map((message) => message.content)

/** A provider that refuses its first request as too long and answers every later one. */
const overflowingOnce = (): {
  readonly requests: Array<ModelProviderRequest>
  readonly shape: ModelProvider
} => {
  const requests: Array<ModelProviderRequest> = []
  return {
    requests,
    shape: {
      protocolVersion: 1,
      stream: (request): ReadonlyArray<ModelStreamItem> => {
        requests.push(request)
        if (requests.length === 1)
          throw new SemanticResponseError("input exceeds the window", "context_length_exceeded")
        return [response("done")]
      }
    }
  }
}

describe("a reply cut off at the output limit", () => {
  it("continues the run with one meta message and ends on the next full reply", async () => {
    const model = scriptedProvider([[response("part one", "length")], [response("part two")]])
    const agent = makeAgent(
      { model: "test-model" },
      { provider: model.shape, toolset: emptyToolset }
    )

    const result = await agent.run([{ role: "user", content: "write a lot" }])

    expect(result.stop_reason).toBe("end_turn")
    expect(result.text).toBe("part two")
    expect(model.requests).toHaveLength(2)
    expect(contents(model.requests[1]).slice(-3)).toEqual([
      "write a lot",
      "part one",
      "Your last reply was cut off at the output token limit. Continue from where it stopped " +
        "and do not repeat what you already wrote. Split the remaining work into smaller steps."
    ])
  })

  it("stops with max_output_length after two continuations in a row", async () => {
    const model = scriptedProvider([
      [response("one", "length")],
      [response("two", "length")],
      [response("three", "length")]
    ])
    const agent = makeAgent(
      { model: "test-model" },
      { provider: model.shape, toolset: emptyToolset }
    )

    const result = await agent.run([{ role: "user", content: "write a lot" }])

    expect(result.stop_reason).toBe("max_output_length")
    expect(result.text).toBe("three")
    expect(model.requests).toHaveLength(3)
  })
})

describe("a request the provider refuses as too long", () => {
  it("is sent again once a middleware shortens the history in answer", async () => {
    const model = overflowingOnce()
    const overflowSeen: Array<boolean> = []
    const shorten: ModelRequestMiddleware = async (request, next) => {
      const prepared = await next(request)
      overflowSeen.push(prepared.contextOverflow === true)
      if (prepared.contextOverflow !== true) return prepared
      const { contextOverflow: _, ...answered } = prepared
      const messages = [{ role: "user" as const, content: "summary of the long chat" }]
      return { ...answered, messages, compactionReplacement: messages }
    }
    const mintedTurns: Array<number> = []
    const agent = makeAgent(
      {
        model: "test-model",
        modelRequestMiddlewares: [shorten],
        mintMessageId: (kind, position) => {
          mintedTurns.push(position.turn)
          return `${kind}-${position.turn}-${position.fragment}-${position.index}`
        }
      },
      { provider: model.shape, toolset: emptyToolset }
    )

    const result = await agent.run([
      { role: "user", content: "a very long chat" },
      { role: "assistant", content: "a very long answer" },
      { role: "user", content: "go on" }
    ])

    expect(overflowSeen).toEqual([false, true])
    expect(new Set(mintedTurns)).toEqual(new Set([0]))
    expect(result.stop_reason).toBe("end_turn")
    expect(result.text).toBe("done")
    expect(model.requests).toHaveLength(2)
    expect(contents(model.requests[1])).toEqual(["summary of the long chat"])
    expect(result.messages.map((message) => message.content)).toEqual([
      "summary of the long chat",
      "done"
    ])
  })

  it("fails the run with the refusal when no middleware shortens the history", async () => {
    const model = overflowingOnce()
    const agent = makeAgent(
      { model: "test-model" },
      { provider: model.shape, toolset: emptyToolset }
    )

    const failure = await agent.run([{ role: "user", content: "a very long chat" }]).then(
      () => undefined,
      (cause: unknown) => cause
    )

    expect(providerErrorCode(failure)).toBe("context_length_exceeded")
    expect(model.requests).toHaveLength(1)
  })
})
