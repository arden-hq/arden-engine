/**
 * Live check of the Chat Completions provider against a real server, through
 * the real `makeAgent` loop. Not part of `vitest run`; run it by hand:
 *
 *   CHAT_COMPLETIONS_BASE_URL=http://127.0.0.1:9931/v1 \
 *   CHAT_COMPLETIONS_MODEL=ggml-org/gemma-4-E2B-it-GGUF:Q8_0 \
 *   CHAT_COMPLETIONS_COMPAT='{"structuredOutput":"json_schema","imageInput":true,"parallelToolCalls":true,"toolChoiceNone":"unenforced"}' \
 *   bun --conditions=arden-source libs/loop/test/live/chat-completions.live.ts
 *
 * Optional: CHAT_COMPLETIONS_PROVIDER (origin provider id, default
 * "llama.cpp"), CHAT_COMPLETIONS_API_KEY_ENV (the NAME of the variable that
 * holds the key, sent as a bearer token), CHAT_COMPLETIONS_EFFORT (a
 * reasoning effort to request), CHAT_COMPLETIONS_OVERFLOW_WORDS (default
 * 6000, sized for a 4096-token context; one word is about one token), CHAT_COMPLETIONS_SKIP (comma list
 * of case names). Exits non-zero when a case fails.
 */
import { errorMessage } from "@arden-hq/std/errors"

import { isAbortError } from "../../src/abort.js"
import type { ChatMessage, StandardSchemaV1 } from "../../src/contracts/messages.js"
import {
  usageInputTokens,
  type ModelProvider,
  type ModelProviderRequest
} from "../../src/contracts/provider.js"
import type { ToolDeclaration, ToolEntry, Toolset } from "../../src/contracts/tools.js"
import { renderInteraction } from "../../src/agent/interactions.js"
import { makeAgent, providerErrorCode } from "../../src/index.js"
import { makeChatCompletionsProvider } from "../../src/providers/chat-completions/provider.js"
import { makeToolSearch } from "../../src/tools/search.js"

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

const baseUrl = required("CHAT_COMPLETIONS_BASE_URL")
const model = required("CHAT_COMPLETIONS_MODEL")
const providerId = process.env.CHAT_COMPLETIONS_PROVIDER ?? "llama.cpp"
const keyVariable = process.env.CHAT_COMPLETIONS_API_KEY_ENV
const apiKey = keyVariable === undefined ? undefined : required(keyVariable)
const effort = process.env.CHAT_COMPLETIONS_EFFORT
const overflowWords = Number(process.env.CHAT_COMPLETIONS_OVERFLOW_WORDS ?? "6000")
const skipped = new Set((process.env.CHAT_COMPLETIONS_SKIP ?? "").split(",").filter(Boolean))
const compat: unknown = JSON.parse(process.env.CHAT_COMPLETIONS_COMPAT ?? "{}")

/** llama.cpp's own prompt accounting per request (`timings` on the usage chunk), when it sends one. */
interface Timing {
  readonly prompt_n: number
  readonly cache_n: number
}
const timings: Array<Promise<Timing | undefined>> = []

/** `fetch` that also reads the stream's last `timings` object, without touching what the provider reads. */
const timedFetch: typeof globalThis.fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init)
  if (response.body === null) return response
  const [mine, theirs] = response.body.tee()
  timings.push(
    new Response(mine).text().then(
      (text) => {
        let found: Timing | undefined
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: {")) continue
          const chunk: unknown = JSON.parse(line.slice(6))
          if (typeof chunk === "object" && chunk !== null && "timings" in chunk)
            found = chunk.timings as Timing
        }
        return found
      },
      () => undefined
    )
  )
  return new Response(theirs, response)
}

const chatCompletions = makeChatCompletionsProvider({
  providerId,
  baseUrl,
  fetch: timedFetch,
  ...(apiKey === undefined
    ? {}
    : { auth: { headers: async () => ({ authorization: `Bearer ${apiKey}` }) } }),
  ...(typeof compat === "object" && compat !== null ? { compat } : {})
})

/** The same provider, printing each transport retry so a slow case shows why. */
const provider: ModelProvider = {
  ...chatCompletions,
  stream: async function* (request) {
    for await (const item of await chatCompletions.stream(request)) {
      if (item._tag === "ProviderStreamRetry") console.log(`  retry: ${JSON.stringify(item)}`)
      yield item
    }
  }
}

const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC"

const weatherEntry: ToolEntry = {
  description: "Current weather for one city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
    additionalProperties: false
  },
  meta: { name: "weather" }
}

const weatherToolset = (calls: Array<string>): Toolset => ({
  entries: () => [weatherEntry],
  loadedNames: () => new Set(),
  load: () => {},
  execute: (request) => {
    const city = typeof request.args.city === "string" ? request.args.city : "?"
    calls.push(city)
    const reading = city.toLowerCase().includes("rome") ? "Cloudy, 17C" : "Sunny, 21C"
    return { content: `${city}: ${reading}`, preview: reading }
  }
})

const noTools: Toolset = {
  entries: () => [],
  loadedNames: () => new Set(),
  load: () => {},
  execute: () => {
    throw new Error("no tools in this case")
  }
}

/**
 * A deferred catalog of 40 tools in 8 groups, plus one tool only it can
 * answer with: `order_status` returns a tracking code the model cannot guess.
 */
const TRACKING = "DHL-7Q2X"
const CATALOG: ReadonlyArray<ToolEntry> = [
  ...["mail", "calendar", "files", "notes", "contacts", "music", "photos", "travel"].flatMap(
    (group) =>
      ["list", "create", "update", "delete", "search"].map((verb): ToolEntry => ({
        description: `${verb[0]?.toUpperCase()}${verb.slice(1)} ${group} items for the person. Returns a short confirmation or the matching ${group} items.`,
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: `The ${group} item id` },
            text: { type: "string", description: "Free text for the item" }
          },
          additionalProperties: false
        },
        meta: { name: `${group}_${verb}`, deferred: true, group }
      }))
  ),
  {
    description: "Look up the shipping status of a customer order by its order number.",
    parameters: {
      type: "object",
      properties: { order: { type: "string", description: "The order number" } },
      required: ["order"],
      additionalProperties: false
    },
    meta: { name: "order_status", deferred: true, group: "shop" }
  }
]

const catalogToolset = (calls: Array<string>): Toolset => {
  const loaded = new Set<string>()
  return {
    entries: () => [weatherEntry, ...CATALOG],
    loadedNames: () => new Set(loaded),
    load: (names) => {
      for (const name of names) loaded.add(name)
    },
    execute: (request) => {
      calls.push(`${request.name} ${JSON.stringify(request.args)}`)
      if (request.name !== "order_status") return { content: "Done.", preview: "Done." }
      const content = `Order ${String(request.args.order)}: shipped, tracking code ${TRACKING}.`
      return { content, preview: "shipped" }
    }
  }
}

const declarationOf = (entry: ToolEntry): ToolDeclaration => ({
  name: entry.meta.name,
  description: entry.description,
  parameters: entry.parameters,
  ...(entry.meta.group === undefined ? {} : { group: entry.meta.group })
})

/** The whole prompt one request costs, cached or not. */
const promptTokens = async (request: ModelProviderRequest): Promise<number> => {
  for await (const item of await chatCompletions.stream(request)) {
    if (item._tag === "Completed") return usageInputTokens(item.usage)
  }
  throw new Error("no completion")
}

const agentWith = (toolset: Toolset) =>
  makeAgent(
    { model, maxOutputTokens: 1024, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
    { provider, toolset }
  )

const assistants = (messages: ReadonlyArray<ChatMessage>) =>
  messages.flatMap((message) => (message.role === "assistant" ? [message] : []))

const check = (condition: boolean, detail: string): void => {
  if (!condition) throw new Error(detail)
}

const cases: ReadonlyArray<readonly [string, () => Promise<string>]> = [
  [
    "plain-answer",
    async () => {
      const result = await agentWith(noTools).run([
        { role: "user", content: "Reply with the single word: pong" }
      ])
      check(/pong/i.test(result.text), `text was ${JSON.stringify(result.text)}`)
      const origin = assistants(result.messages).at(-1)?.origin
      check(origin?.api === "chat-completions", `origin was ${JSON.stringify(origin)}`)
      return `text=${JSON.stringify(result.text)} origin=${JSON.stringify(origin)} usage=${JSON.stringify(result.usage)}`
    }
  ],
  [
    "tool-round-trip+second-turn",
    async () => {
      const calls: Array<string> = []
      const agent = agentWith(weatherToolset(calls))
      const first = await agent.run([
        { role: "user", content: "Use the weather tool for Paris, then tell me the temperature." }
      ])
      check(calls.length >= 1, "the model never called the tool")
      check(/21/.test(first.text), `answer did not use the result: ${JSON.stringify(first.text)}`)
      const second = await agent.run([
        ...first.messages,
        { role: "user", content: "Which city did you just check? One word." }
      ])
      check(/paris/i.test(second.text), `second turn: ${JSON.stringify(second.text)}`)
      return `calls=${JSON.stringify(calls)} first=${JSON.stringify(first.text)} second=${JSON.stringify(second.text)}`
    }
  ],
  [
    "two-tools-one-turn",
    async () => {
      const calls: Array<string> = []
      const result = await agentWith(weatherToolset(calls)).run([
        {
          role: "user",
          content:
            "Call the weather tool for Paris and for Rome in the same turn, then compare them."
        }
      ])
      const widest = Math.max(...assistants(result.messages).map((m) => m.tool_calls?.length ?? 0))
      check(widest >= 2, `largest batch was ${widest} call(s); calls=${JSON.stringify(calls)}`)
      return `calls=${JSON.stringify(calls)} text=${JSON.stringify(result.text)}`
    }
  ],
  [
    "reasoning-separate",
    async () => {
      let reasoning = ""
      let text = ""
      for await (const event of agentWith(noTools).stream([
        // A question a model reasons about at any effort: OpenRouter's Claude
        // and GPT models skip thinking on "what is 17 * 3?" (2026-11-16).
        {
          role: "user",
          content:
            "A train leaves at 9:47 and arrives at 13:12 the same day. Work it out step by step, then answer with the trip length in minutes."
        }
      ])) {
        if (!("_tag" in event)) continue
        if (event._tag === "ReasoningDelta") reasoning += event.content
        if (event._tag === "TextDelta") text += event.content
      }
      check(reasoning.length > 0, "no reasoning deltas arrived")
      check(!text.includes(reasoning), "the reasoning leaked into the text")
      check(/205/.test(text), `text was ${JSON.stringify(text)}`)
      return `reasoning=${reasoning.length} chars text=${JSON.stringify(text)}`
    }
  ],
  [
    "structured-output",
    async () => {
      const schema: StandardSchemaV1 = {
        "~standard": {
          version: 1,
          vendor: "live",
          validate: (value) =>
            typeof value === "object" &&
            value !== null &&
            "city" in value &&
            typeof value.city === "string" &&
            "temperature" in value &&
            typeof value.temperature === "number"
              ? { value }
              : { issues: [{ message: "expected { city: string, temperature: number }" }] }
        }
      }
      const result = await agentWith(noTools).run(
        [{ role: "user", content: "Give the city Paris with temperature 21 as JSON." }],
        {
          output: {
            schema,
            name: "reading",
            toJsonSchema: () => ({
              type: "object",
              properties: { city: { type: "string" }, temperature: { type: "number" } },
              required: ["city", "temperature"],
              additionalProperties: false
            })
          }
        }
      )
      return `object=${JSON.stringify(result.object)}`
    }
  ],
  [
    "image-input",
    async () => {
      const result = await agentWith(noTools).run([
        {
          role: "user",
          content: [
            { type: "text", text: "What single color fills this image? One word." },
            { type: "image", media_type: "image/png", data: RED_PNG }
          ]
        }
      ])
      check(/red/i.test(result.text), `text was ${JSON.stringify(result.text)}`)
      return `text=${JSON.stringify(result.text)}`
    }
  ],
  [
    "cancel-mid-stream",
    async () => {
      const controller = new AbortController()
      let abortedAt = 0
      let outcome = "ended without error"
      try {
        for await (const event of agentWith(noTools).stream(
          [{ role: "user", content: "Write a 400-word story about a lighthouse." }],
          { signal: controller.signal }
        )) {
          if ("_tag" in event && (event._tag === "TextDelta" || event._tag === "ReasoningDelta")) {
            if (abortedAt === 0) {
              abortedAt = performance.now()
              controller.abort()
            }
          }
        }
      } catch (error) {
        outcome = isAbortError(error) ? "AbortError" : `other error: ${errorMessage(error)}`
      }
      const tookMs = Math.round(performance.now() - abortedAt)
      check(abortedAt > 0, "no delta arrived before the stream ended")
      check(outcome === "AbortError", outcome)
      check(tookMs < 2000, `took ${tookMs} ms to stop`)
      return `${outcome} after ${tookMs} ms`
    }
  ],
  [
    "context-overflow",
    async () => {
      try {
        await agentWith(noTools).run([{ role: "user", content: "word ".repeat(overflowWords) }])
      } catch (error) {
        const code = providerErrorCode(error)
        check(
          code === "context_length_exceeded",
          `code was ${String(code)}: ${errorMessage(error)}`
        )
        return `${code}: ${errorMessage(error instanceof Error ? error.cause : error)}`
      }
      throw new Error("the over-long prompt was accepted")
    }
  ],
  [
    "tool-search",
    async () => {
      const calls: Array<string> = []
      timings.length = 0
      const result = await agentWith(catalogToolset(calls)).run([
        {
          role: "user",
          content: "What is the shipping status of my order 4471? I need the tracking code."
        }
      ])
      const searched = assistants(result.messages).flatMap((message) =>
        (message.provider_tool_calls ?? []).filter((call) => call.name === "tool_search")
      )
      check(searched.length > 0, "the model never searched")
      check(
        searched.some((call) => call.loaded_tool_names?.includes("order_status") === true),
        `order_status never loaded: ${JSON.stringify(searched)}`
      )
      check(
        calls.some((call) => call.startsWith("order_status")),
        `order_status never ran: ${JSON.stringify(calls)}`
      )
      check(
        result.text.includes(TRACKING),
        `answer did not use the result: ${JSON.stringify(result.text)}`
      )
      const steps = (await Promise.all(timings)).map((timing, index) =>
        timing === undefined
          ? `#${index + 1} ?`
          : `#${index + 1} prompt_n=${timing.prompt_n} cache_n=${timing.cache_n}`
      )
      const deferred = CATALOG.map(declarationOf)
      const base = {
        model,
        messages: result.messages.slice(0, 1),
        renderInteraction,
        toolChoice: "auto" as const,
        maxOutputTokens: 1
      }
      const without = await promptTokens({
        ...base,
        tools: [declarationOf(weatherEntry), ...deferred],
        deferredTools: []
      })
      const withSearch = await promptTokens({
        ...base,
        tools: [declarationOf(weatherEntry)],
        deferredTools: deferred,
        toolSearch: makeToolSearch({
          catalog: CATALOG.map((entry) => ({
            declaration: declarationOf(entry),
            meta: entry.meta
          })),
          loaded: new Set()
        })
      })
      return [
        `searches=${JSON.stringify(searched.map((call) => call.arguments))}`,
        `calls=${JSON.stringify(calls)}`,
        `text=${JSON.stringify(result.text)}`,
        `steps: ${steps.join(", ")}`,
        `prompt tokens for ${CATALOG.length + 1} tools: without search ${without}, with search ${withSearch}`
      ].join("\n  ")
    }
  ],
  [
    "mid-conversation-system-and-developer",
    async () => {
      const result = await agentWith(noTools).run([
        { role: "system", content: "You are terse." },
        { role: "user", content: "Say hello." },
        { role: "assistant", content: "Hello." },
        { role: "system", content: "From now on, answer only in French." },
        { role: "developer", content: "End every answer with the word FIN." },
        { role: "user", content: "Say good morning." }
      ])
      check(result.text.length > 0, "empty answer")
      return `text=${JSON.stringify(result.text)}`
    }
  ]
]

let failures = 0
for (const [name, run] of cases) {
  if (skipped.has(name)) {
    console.log(`SKIP ${name}`)
    continue
  }
  const started = performance.now()
  try {
    const detail = await run()
    console.log(`PASS ${name} (${Math.round(performance.now() - started)} ms) ${detail}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}: ${errorMessage(error)}`)
  }
}
process.exitCode = failures === 0 ? 0 : 1
