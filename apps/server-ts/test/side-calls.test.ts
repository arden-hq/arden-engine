import type { ModelProvider, ModelProviderRequest } from "@arden-hq/loop"
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

/** A provider that answers every request with `answer` and records what it was asked. */
const recording = (answer: string) => {
  const requests: Array<ModelProviderRequest> = []
  const provider: ModelProvider = {
    protocolVersion: 1,
    capabilities: () => ({ hostedTools: [], structuredOutput: "native" }),
    stream: (request) => {
      requests.push(request)
      return [
        {
          _tag: "Completed",
          message: {
            role: "assistant",
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

const host = (reasoningEfforts: ReadonlyArray<string>): ModelHost => ({
  models: [
    {
      id: "m",
      name: "m",
      provider: { id: "p", name: "P" },
      reasoningEfforts,
      context: { hardLimit: 32_768, compactionTrigger: 26_214 }
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

/** What a helper side call put on the provider request, for a model and its assignment. */
const helperRequest = async (
  call: (completion: StructuredCompletion["Service"]) => Effect.Effect<unknown, unknown>,
  { efforts, assigned }: { efforts: ReadonlyArray<string>; assigned: string | null }
) => {
  const model = recording('{"title":"Lisbon trip"}')
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
          installed: () => makeSettingsRuntime(host(efforts))
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
      // Only the request matters here; a worker that never finishes fails after it.
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
    // llama.cpp offers `none` for every model; OpenRouter where reasoning is optional.
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
    // A Codex model always carries its default effort, so its helper calls keep it.
    expect(
      await helperRequest(name, { efforts: ["low", "medium", "high"], assigned: "medium" })
    ).toEqual({ maxOutputTokens: 80 + REASONING_ALLOWANCE_TOKENS, reasoningEffort: "medium" })
    // OpenRouter lists models whose reasoning is mandatory without any effort.
    expect(await helperRequest(name, { efforts: [], assigned: null })).toEqual({
      maxOutputTokens: 80 + REASONING_ALLOWANCE_TOKENS,
      reasoningEffort: undefined
    })
    // An effort chosen for the helper wins, `none` included.
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

  it("sizes a compaction summary for thinking within its quarter of the window", async () => {
    const limitFor = async (reasoningEffort: string | null, contextWindow: number) => {
      const model = recording("Handoff: planning a trip to Lisbon.")
      await summarizeContext({
        provider: model.provider,
        model: "m",
        reasoningEffort,
        sessionRef: "chat-1",
        sourceText: "user: plan a trip to Lisbon",
        contextWindow,
        maxOutputTokens: 1_500,
        onResponse: () => undefined
      })
      return model.requests.map((request) => request.maxOutputTokens)
    }
    expect(await limitFor("none", 131_072)).toEqual([1_500])
    expect(await limitFor(null, 131_072)).toEqual([1_500 + REASONING_ALLOWANCE_TOKENS])
    expect(await limitFor("high", 16_384)).toEqual([4_096])
  })
})
