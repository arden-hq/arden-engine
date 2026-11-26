import { ROLE } from "@arden-hq/std/message-vocabulary"
import { describe, expect, it } from "vitest"

import type { AssistantMessage, ChatMessage } from "../src/contracts/messages.js"
import { makeAgent } from "../src/index.js"
import { collect, completionOf, defined, sseResponse } from "./kit.js"
import { answered, call, provider, request, sentMessages, weather } from "./chat-completions-kit.js"

describe("OpenRouter reasoning_details", () => {
  const routerChunk = (delta: unknown, finish: string | null = null) => ({
    id: "gen-1",
    provider: "OpenAI",
    model: "openai/gpt-6-luna",
    object: "chat.completion.chunk",
    created: 1794771400,
    choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish }]
  })
  const format = "openai-responses-v1"
  const details = [
    { type: "reasoning.summary", summary: "Plan it.", index: 0, format },
    { type: "reasoning.encrypted", data: "enc-blob", id: "rs_1", index: 1, format }
  ]

  it("accumulates fragments by index, stores them, and replays them only to the same origin", async () => {
    const router = provider(
      [
        () =>
          sseResponse([
            routerChunk({
              role: ROLE.assistant,
              content: "",
              reasoning: "Plan",
              reasoning_details: [{ type: "reasoning.summary", summary: "Plan", index: 0, format }]
            }),
            routerChunk({
              reasoning: " it.",
              reasoning_details: [{ type: "reasoning.summary", summary: " it.", index: 0, format }]
            }),
            routerChunk({
              reasoning_details: [
                { type: "reasoning.encrypted", data: "enc-blob", id: "rs_1", index: 1, format }
              ]
            }),
            routerChunk({ content: "Done." }),
            routerChunk({}, "stop"),
            {
              ...routerChunk({}),
              choices: [],
              usage: {
                prompt_tokens: 30,
                completion_tokens: 12,
                prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 4 },
                cost: 0.0001
              }
            },
            "[DONE]"
          ]),
        answered("Again."),
        answered("Again."),
        answered("Again.")
      ],
      { providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }
    )

    const completed = completionOf(
      await collect(router.provider.stream(request({ model: "openai/gpt-6-luna" })))
    )
    expect(completed).toEqual({
      _tag: "Completed",
      message: {
        role: ROLE.assistant,
        content: "Done.",
        tool_calls: null,
        reasoning_content: "Plan it.",
        output_parts: [
          { type: "reasoning", text: "Plan it." },
          { type: "text", text: "Done." }
        ],
        provider_state: { "chat-completions": { reasoning_details: details } },
        origin: {
          provider: "openrouter",
          api: "chat-completions",
          model: "openai/gpt-6-luna",
          requested_model: "openai/gpt-6-luna"
        }
      },
      finish_reason: "stop",
      usage: {
        prompt_tokens: 16,
        completion_tokens: 12,
        cache_read_tokens: 10,
        cache_write_tokens: 4,
        cost: 0.0001
      },
      model: "openai/gpt-6-luna"
    })

    const stored: AssistantMessage = {
      role: ROLE.assistant,
      content: "Done.",
      provider_state: defined(completed.message.provider_state, "provider state"),
      origin: defined(completed.message.origin, "an origin")
    }
    const messages: ReadonlyArray<ChatMessage> = [
      { role: ROLE.user, content: "Q" },
      stored,
      { role: ROLE.user, content: "Next" }
    ]
    const other = provider([answered("Again.")], {
      providerId: "other-router",
      baseUrl: "https://example.test/v1"
    })
    await collect(router.provider.stream(request({ model: "openai/gpt-6-luna", messages })))
    await collect(
      router.provider.stream(request({ model: "anthropic/claude-sonnet-5.5", messages }))
    )
    await collect(other.provider.stream(request({ model: "openai/gpt-6-luna", messages })))

    const replayed = [...router.transport.requests.slice(1), ...other.transport.requests].map(
      (sent) => (sentMessages(sent.body) as ReadonlyArray<unknown>)[1]
    )
    expect(replayed).toEqual([
      { role: ROLE.assistant, content: "Done.", reasoning_details: details },
      { role: ROLE.assistant, content: "Done." },
      { role: ROLE.assistant, content: "Done." }
    ])
  })
})

describe("OpenRouter usage", () => {
  const lastChunk = (model: string, provider: string, usage: unknown) => ({
    id: "gen-1794783619-MvelW4gWCTL0KKjx1E8i",
    object: "chat.completion.chunk",
    created: 1794783619,
    model,
    provider,
    service_tier: "default",
    choices: [
      {
        index: 0,
        delta: { content: "", role: ROLE.assistant },
        finish_reason: "stop",
        native_finish_reason: "end_turn"
      }
    ],
    usage
  })

  it.each([
    [
      "anthropic/claude-haiku-5.5",
      "Claude Platform on AWS",
      {
        prompt_tokens: 38950,
        completion_tokens: 4,
        total_tokens: 38954,
        cost: 0.002116065,
        is_byok: false,
        prompt_tokens_details: {
          cached_tokens: 23949,
          cache_write_tokens: 14979,
          audio_tokens: 0,
          video_tokens: 0
        },
        cost_details: {
          upstream_inference_cost: 0.002116065,
          upstream_inference_prompt_cost: 0.002114065,
          upstream_inference_completions_cost: 0.000002
        },
        completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0, audio_tokens: 0 }
      },
      {
        prompt_tokens: 22,
        completion_tokens: 4,
        cache_read_tokens: 23949,
        cache_write_tokens: 14979,
        cost: 0.002116065
      }
    ]
  ])("splits %s usage into fresh, read and written tokens", async (model, served, usage, split) => {
    const { provider: cc } = provider(
      [() => sseResponse([lastChunk(model, served, usage), "[DONE]"])],
      { providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }
    )
    const completed = completionOf(await collect(cc.stream(request({ model }))))
    expect(completed.usage).toEqual(split)
  })

  it.each([
    ["a free model", { cost: 0, is_byok: false }, 0],
    [
      "BYOK with the upstream bill",
      { cost: 0.003, is_byok: true, cost_details: { upstream_inference_cost: 0.2 } },
      0.203
    ],
    ["BYOK without the upstream bill", { cost: 0.003, is_byok: true }, undefined]
  ])("reads the spend of %s", async (_name, fields, cost) => {
    const { provider: cc } = provider(
      [
        () =>
          sseResponse([
            lastChunk("openai/gpt-6-luna", "OpenAI", {
              prompt_tokens: 10,
              completion_tokens: 2,
              ...fields
            }),
            "[DONE]"
          ])
      ],
      { providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }
    )
    const completed = completionOf(
      await collect(cc.stream(request({ model: "openai/gpt-6-luna" })))
    )
    expect(completed.usage.cost).toBe(cost)
  })

  it("sums every response's spend into the run's usage, and leaves it unknown when one reported none", async () => {
    const answer = (cost: number | undefined) => () =>
      sseResponse([
        lastChunk("openai/gpt-6-luna", "OpenAI", {
          prompt_tokens: 10,
          completion_tokens: 2,
          ...(cost === undefined ? {} : { cost })
        }),
        "[DONE]"
      ])
    const toolCall = (cost: number) => () =>
      sseResponse([
        {
          ...lastChunk("openai/gpt-6-luna", "OpenAI", {
            prompt_tokens: 8,
            completion_tokens: 3,
            cost
          }),
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, ...call("call_1") }] },
              finish_reason: "tool_calls"
            }
          ]
        },
        "[DONE]"
      ])
    const run = async (answers: ReadonlyArray<() => Response>) => {
      const { provider: cc } = provider(answers, {
        providerId: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1"
      })
      return makeAgent(
        { model: "openai/gpt-6-luna" },
        {
          provider: cc,
          toolset: {
            entries: () => [
              {
                description: weather.description,
                parameters: weather.parameters,
                meta: { name: "weather" }
              }
            ],
            loadedNames: () => new Set(),
            load: () => {},
            execute: () => ({ content: "Sunny.", preview: "Sunny." })
          }
        }
      ).run([{ role: ROLE.user, content: "Weather?" }])
    }
    const known = await run([toolCall(0.0004), answer(0.0001)])
    expect(known.usage).toEqual({
      prompt_tokens: 18,
      completion_tokens: 5,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost: 0.0004 + 0.0001
    })
    const unknown = await run([toolCall(0.0004), answer(undefined)])
    expect(unknown.usage).toEqual({
      prompt_tokens: 18,
      completion_tokens: 5,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost: undefined
    })
    expect("cost" in unknown.usage).toBe(true)
  })
})
