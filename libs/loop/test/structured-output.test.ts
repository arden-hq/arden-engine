import { describe, expect, it } from "vitest"

import {
  StructuredOutputError,
  makeAgent,
  type AgentOutputOptions,
  type ModelProvider,
  type ModelProviderRequest,
  type Result,
  type StandardSchemaV1,
  type Toolset
} from "../src/index.js"
import { defined, isRecord, lastOf } from "./kit.js"

const response = (content: string) => ({
  model: "test-model",
  _tag: "Completed" as const,
  message: {
    role: "assistant" as const,
    content,
    tool_calls: null,
    reasoning_content: null
  },
  finish_reason: "stop" as const,
  usage: { prompt_tokens: 1, completion_tokens: 1 }
})

const emptyToolset: Toolset = {
  entries: () => [],
  loadedNames: () => new Set<string>(),
  load: () => undefined,
  execute: () => {
    throw new Error("no tools in this suite")
  }
}

const verdictSchema: StandardSchemaV1<unknown, { verdict: string }> = {
  "~standard": {
    version: 1,
    vendor: "hand-rolled",
    validate: (value) =>
      isRecord(value) && typeof value.verdict === "string"
        ? { value: { verdict: value.verdict } }
        : { issues: [{ message: "verdict must be a string", path: ["verdict"] }] }
  }
}

const output: AgentOutputOptions = {
  schema: verdictSchema,
  toJsonSchema: () => ({
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"]
  }),
  name: "verdict"
}

const scripted = (contents: ReadonlyArray<string>) => {
  const remaining = [...contents]
  const requests: ModelProviderRequest[] = []
  const provider: ModelProvider = {
    protocolVersion: 1,
    capabilities: () => ({ hostedTools: [], structuredOutput: "native" }),
    stream: (request) => {
      requests.push(request)
      return [response(defined(remaining.shift(), "a scripted reply"))]
    }
  }
  return { provider, requests }
}

describe("structured output", () => {
  it("makes exactly one correction retry quoting the validation issues, then succeeds", async () => {
    const script = scripted(['{"verdict":42}', '{"verdict":"fixed"}'])
    const agent = makeAgent(
      { model: "test-model" },
      { provider: script.provider, toolset: emptyToolset }
    )
    const result = await agent.run([{ role: "user", content: "judge" }], { output })

    expect(result.object).toEqual({ verdict: "fixed" })
    expect(script.requests).toHaveLength(2)
    const correction = lastOf(defined(script.requests[1], "a correction request").messages)
    expect(correction).toMatchObject({
      role: "user",
      message_id: expect.any(String),
      is_meta: true
    })
    expect(correction.content).toContain("verdict: verdict must be a string")
    expect(result.messages.filter((message) => message.role === "user")).toHaveLength(2)
  })

  it("fails with the typed StructuredOutputError when the correction is still invalid", async () => {
    const script = scripted(["not json at all", "{}"])
    const agent = makeAgent(
      { model: "test-model" },
      { provider: script.provider, toolset: emptyToolset }
    )
    const failure = await agent.run([{ role: "user", content: "judge" }], { output }).then(
      () => null,
      (cause: unknown) => cause
    )

    if (!(failure instanceof StructuredOutputError))
      throw new Error("expected a StructuredOutputError")
    expect(failure._tag).toBe("StructuredOutputError")
    expect(failure.issues).toEqual([{ message: "verdict must be a string", path: ["verdict"] }])
    expect(script.requests).toHaveLength(2)
  })
})

describe("final text check", () => {
  it("corrects the final answer once, then keeps the second answer even if it still fails", async () => {
    const script = scripted(["first answer", "second answer", "never requested"])
    const checked: string[] = []
    const agent = makeAgent(
      { model: "test-model" },
      {
        provider: script.provider,
        toolset: emptyToolset,
        hooks: {
          checkFinalText: (text) => {
            checked.push(text)
            return "Line 3: fix the block."
          }
        }
      }
    )
    const superseded: Array<{ messageIds: ReadonlyArray<string>; correctionId: string }> = []
    let result: Result | undefined
    for await (const event of agent.stream([{ role: "user", content: "answer" }])) {
      if (!("_tag" in event)) result = event
      else if (event._tag === "FinalTextSuperseded")
        superseded.push({
          messageIds: event.message_ids,
          correctionId: event.correction_message_id
        })
    }
    const final = defined(result, "a terminal result")

    expect(final.text).toBe("second answer")
    expect(checked).toEqual(["first answer"])
    expect(script.requests).toHaveLength(2)
    const correction = lastOf(defined(script.requests[1], "a correction request").messages)
    expect(correction).toMatchObject({
      role: "user",
      is_meta: true,
      content: "Line 3: fix the block."
    })
    const firstAnswer = defined(
      final.messages.find(
        (message) => message.role === "assistant" && message.content === "first answer"
      ),
      "the rejected answer"
    )
    expect(superseded).toEqual([
      { messageIds: [firstAnswer.message_id], correctionId: correction.message_id }
    ])
    expect(correction).toMatchObject({ rejected_message_ids: [firstAnswer.message_id] })
  })
})
