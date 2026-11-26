import { MODEL_PROVIDER_PROTOCOL } from "@arden-hq/loop"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ModelCapabilities, ModelProvider, ModelProviderRequest } from "@arden-hq/loop"
import type { ModelAssignment } from "@arden-hq/protocol/models"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { summarizeContext } from "../src/context/summarizer.js"
import { ModelCatalog } from "../src/models/catalog.js"
import type { ModelHost } from "../src/models/host.js"
import { ModelProviderService } from "../src/models/provider.js"
import { REASONING_ALLOWANCE_TOKENS } from "../src/models/side-call.js"
import { StructuredCompletion } from "../src/models/structured-completion.js"
import { makeSettingsRuntime } from "../src/persistence/models/settings.js"
import { ModelStore } from "../src/persistence/models/store.js"
import { UsageStore } from "../src/persistence/usage/store.js"
import { partialService } from "./kit.js"

const recording = (answer: string, outputLimit: ModelCapabilities["outputLimit"] = undefined) => {
  const requests: Array<ModelProviderRequest> = []
  const provider: ModelProvider = {
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
    capabilities: () => ({
      hostedTools: [],
      structuredOutput: "native",
      ...(outputLimit === undefined ? {} : { outputLimit })
    }),
    stream: (request) => {
      requests.push(request)
      return [
        {
          _tag: "Completed",
          message: {
            role: ROLE.assistant,
            content: answer,
            tool_calls: null,
            reasoning_content: null
          },
          finish_reason: "stop",
          usage: { prompt_tokens: 2, completion_tokens: 1 },
          model: request.model
        }
      ]
    }
  }
  return { requests, provider }
}

const host = (reasoningEfforts: ReadonlyArray<string>, outputCap?: number): ModelHost => ({
  models: [
    {
      id: "m",
      name: "m",
      provider: { id: "p", name: "P" },
      reasoningEfforts,
      context: {
        hardLimit: 32_768,
        compactionTrigger: 26_214,
        ...(outputCap === undefined ? {} : { outputCap })
      }
    }
  ],
  defaults: {
    chatModelId: "m",
    reasoningEfforts: {},
    roles: {
      background: { modelId: null, reasoningEffort: null },
      helper: { modelId: null, reasoningEffort: null }
    }
  }
})

const helperRequest = async (
  call: (completion: StructuredCompletion["Service"]) => Effect.Effect<unknown, unknown>,
  {
    efforts,
    assigned,
    outputCap,
    outputLimit
  }: {
    efforts: ReadonlyArray<string>
    assigned: string | null
    outputCap?: number
    outputLimit?: ModelCapabilities["outputLimit"]
  }
) => {
  const model = recording('{"title":"Lisbon trip"}', outputLimit)
  const assignment: ModelAssignment = { modelId: "m", reasoningEffort: assigned }
  const layer = StructuredCompletion.layer.pipe(
    Layer.provide(ModelProviderService.layer({ provider: model.provider })),
    Layer.provide(
      Layer.succeed(
        ModelStore,
        partialService<ModelStore["Service"]>("ModelStore", {
          roleSelection: () => Effect.succeed(assignment)
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        ModelCatalog,
        partialService<ModelCatalog["Service"]>("ModelCatalog", {
          installed: () => makeSettingsRuntime(host(efforts, outputCap))
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        UsageStore,
        partialService<UsageStore["Service"]>("UsageStore", { recordModelCall: () => Effect.void })
      )
    )
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const completion = yield* StructuredCompletion
      yield* Effect.exit(call(completion))
    }).pipe(Effect.provide(layer))
  )
  const [request] = model.requests
  if (request === undefined) throw new Error("no model request")
  return { maxOutputTokens: request.maxOutputTokens, reasoningEffort: request.reasoningEffort }
}

const usage = { kind: "chat_title", owner: { type: "none" } } as const

const name = (completion: StructuredCompletion["Service"]) =>
  completion.runText({
    role: "helper",
    usage,
    system: "Name the chat.",
    user: "Plan a trip to Lisbon",
    maxOutputTokens: 80,
    maxCharacters: 100
  })

describe("a side call's effort and output limit", () => {
  it("turns thinking off where the model declares the switch, and keeps the answer budget", async () => {
    expect(await helperRequest(name, { efforts: ["none"], assigned: null })).toEqual({
      maxOutputTokens: 80,
      reasoningEffort: "none"
    })
    const structured = (completion: StructuredCompletion["Service"]) =>
      completion.run({
        role: "helper",
        usage,
        system: "Name the chat.",
        user: "Plan a trip to Lisbon",
        output: Schema.Struct({ title: Schema.String }),
        outputName: "chat_name",
        maxOutputTokens: 300
      })
    expect(
      await helperRequest(structured, { efforts: ["high", "low", "none"], assigned: null })
    ).toEqual({ maxOutputTokens: 300, reasoningEffort: "none" })
  })

  it("leaves room for thinking at an assigned effort or the model's default", async () => {
    const medium = await helperRequest(name, {
      efforts: ["low", "medium", "high"],
      assigned: "medium"
    })
    expect(medium.reasoningEffort).toBe("medium")
    expect(medium.maxOutputTokens).toBeGreaterThan(80)
    const mandatory = await helperRequest(name, { efforts: [], assigned: null })
    expect(mandatory.reasoningEffort).toBeUndefined()
    expect(mandatory.maxOutputTokens).toBeGreaterThan(80)
    expect(await helperRequest(name, { efforts: ["none", "high"], assigned: "none" })).toEqual({
      maxOutputTokens: 80,
      reasoningEffort: "none"
    })
  })

  it("keeps a multi-step worker at its assigned effort", async () => {
    const worker = (completion: StructuredCompletion["Service"]) =>
      completion.runTool({
        role: "helper",
        usage,
        system: "Do the task.",
        user: "Open the page",
        maxOutputTokens: 4_000,
        result: {
          schema: Schema.Struct({ done: Schema.Boolean }),
          name: "finish",
          displayName: "Finish",
          description: "Report the result"
        },
        steps: { tools: [], maxIterations: 3, maxToolCalls: 3 }
      })
    expect(await helperRequest(worker, { efforts: ["none"], assigned: null })).toEqual({
      maxOutputTokens: 4_000 + REASONING_ALLOWANCE_TOKENS,
      reasoningEffort: undefined
    })
  })

  it("keeps a route that sends no output limit at the model's own effort", async () => {
    expect(
      await helperRequest(name, {
        efforts: ["none", "low"],
        assigned: null,
        outputLimit: "omitted"
      })
    ).toEqual({ maxOutputTokens: 80 + REASONING_ALLOWANCE_TOKENS, reasoningEffort: undefined })
  })

  it("never asks for more output than the model's own cap", async () => {
    expect(await helperRequest(name, { efforts: [], assigned: null, outputCap: 1_024 })).toEqual({
      maxOutputTokens: 1_024,
      reasoningEffort: undefined
    })
  })

  describe("a compaction summary", () => {
    const summary = async (input: {
      readonly reasoningEffort: string | null
      readonly contextWindow: number
      readonly outputCap?: number
    }) => {
      const model = recording("Handoff: planning a trip to Lisbon.")
      await summarizeContext({
        provider: model.provider,
        model: "m",
        reasoningEffort: input.reasoningEffort,
        sessionRef: "chat-1",
        sourceText: "x".repeat(200_000),
        contextWindow: input.contextWindow,
        maxOutputTokens: 1_500,
        outputCap: input.outputCap,
        onResponse: () => undefined
      })
      return model.requests.map((request) => {
        const source = request.messages[1]?.content
        return {
          limit: request.maxOutputTokens,
          sourceChars: typeof source === "string" ? source.length : undefined
        }
      })
    }

    it("leaves room for thinking on top of the handoff, however small the window", async () => {
      expect(await summary({ reasoningEffort: "none", contextWindow: 131_072 })).toEqual([
        { limit: 1_500, sourceChars: 131_072 - 1_500 - 2_000 }
      ])
      expect(await summary({ reasoningEffort: null, contextWindow: 131_072 })).toEqual([
        {
          limit: 1_500 + REASONING_ALLOWANCE_TOKENS,
          sourceChars: 131_072 - 1_500 - REASONING_ALLOWANCE_TOKENS - 2_000
        }
      ])
      expect(await summary({ reasoningEffort: "high", contextWindow: 8_192 })).toEqual([
        {
          limit: 1_500 + REASONING_ALLOWANCE_TOKENS,
          sourceChars: 8_192 - 1_500 - REASONING_ALLOWANCE_TOKENS - 2_000
        }
      ])
    })

    it("stays within the model's output cap", async () => {
      expect(
        await summary({ reasoningEffort: "high", contextWindow: 131_072, outputCap: 1_000 })
      ).toEqual([{ limit: 1_000, sourceChars: 131_072 - 1_000 - 2_000 }])
    })
  })
})
