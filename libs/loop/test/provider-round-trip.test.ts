import { ROLE } from "@arden-hq/std/message-vocabulary"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { renderInteraction } from "../src/agent/interactions.js"
import { assistantMessage } from "../src/agent/model-output.js"
import type { ChatMessage } from "../src/contracts/messages.js"
import type { CompletionResponse, ModelProviderRequest } from "../src/contracts/provider.js"
import { makeChatCompletionsProvider } from "../src/providers/chat-completions/provider.js"
import { makeOpenAiResponsesProvider } from "../src/providers/openai-responses/provider.js"
import { collect, completionOf, recordOf, recordsOf, scriptedFetch, sseResponse } from "./kit.js"

const MODEL = "router/model-1"

const text = fc.string({ unit: "grapheme", maxLength: 40 })
const cuts = fc.array(fc.nat({ max: 60 }), { maxLength: 4 })
const callId = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/)
const toolName = fc.constantFrom("weather", "search_docs", "send_mail")
const argumentsJson = fc
  .tuple(
    fc.dictionary(
      fc.string({ unit: "grapheme", maxLength: 8 }),
      fc.oneof(
        fc.string({ unit: "grapheme", maxLength: 12 }),
        fc.integer(),
        fc.boolean(),
        fc.constant(null)
      ),
      { maxKeys: 4 }
    ),
    fc.constantFrom(undefined, 1, 2),
    fc.constantFrom("", " ", "\n")
  )
  .map(([value, indent, pad]) => `${pad}${JSON.stringify(value, null, indent)}${pad}`)

const toolCalls = fc
  .uniqueArray(callId, { maxLength: 3 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc.record({ id: fc.constant(id), name: toolName, arguments: argumentsJson, cuts })
      )
    )
  )

const pieces = (whole: string, at: ReadonlyArray<number>): ReadonlyArray<string> => {
  const points = Array.from(whole)
  const marks = [...new Set(at.map((mark) => mark % (points.length + 1)))].sort(
    (left, right) => left - right
  )
  const out: Array<string> = []
  let start = 0
  for (const mark of [...marks, points.length]) {
    if (mark > start) out.push(points.slice(start, mark).join(""))
    start = Math.max(start, mark)
  }
  return out
}

const request = (messages: ReadonlyArray<ChatMessage>): ModelProviderRequest => ({
  model: MODEL,
  messages,
  renderInteraction,
  tools: [],
  deferredTools: [],
  toolChoice: "auto"
})

const stored = (response: CompletionResponse): ChatMessage =>
  assistantMessage(
    response,
    "message-1",
    null,
    response.message.output_parts ?? [],
    new Map(),
    undefined
  )

const withParsedArguments = (
  message: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> =>
  message.tool_calls === undefined
    ? message
    : {
        ...message,
        tool_calls: recordsOf(message.tool_calls).map((call) => {
          const fn = recordOf(call.function)
          return {
            ...call,
            function: {
              ...fn,
              arguments: typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments
            }
          }
        })
      }

const toolOutputs = (ids: ReadonlyArray<string>): ReadonlyArray<ChatMessage> =>
  ids.map((id) => ({ role: ROLE.tool, tool_call_id: id, content: `out ${id}` }))

describe("Chat Completions: what the model sent comes back unchanged on the next turn", () => {
  const chunk = (delta: unknown, finish: string | null = null) => ({
    id: "gen-1",
    model: MODEL,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }]
  })
  const format = "openai-responses-v1"

  it("keeps the text, every tool call and the reasoning details, in order", async () => {
    await fc.assert(
      fc.asyncProperty(
        text,
        cuts,
        fc.option(fc.tuple(text, cuts), { nil: undefined }),
        fc.option(fc.stringMatching(/^[A-Za-z0-9+/=]{1,40}$/), { nil: undefined }),
        toolCalls,
        fc.option(text, { nil: undefined }),
        fc.array(fc.nat({ max: 5 }), { maxLength: 24 }),
        async (content, contentCuts, summary, encrypted, calls, refusal, order) => {
          const frames: Array<unknown> = [chunk({ role: ROLE.assistant, content: "" })]
          for (const piece of summary === undefined ? [] : pieces(summary[0], summary[1]))
            frames.push(
              chunk({
                reasoning_details: [{ type: "reasoning.summary", summary: piece, index: 0, format }]
              })
            )
          if (encrypted !== undefined)
            frames.push(
              chunk({
                reasoning_details: [
                  { type: "reasoning.encrypted", data: encrypted, id: "rs_1", index: 1, format }
                ]
              })
            )
          for (const piece of pieces(content, contentCuts)) frames.push(chunk({ content: piece }))
          if (refusal !== undefined) frames.push(chunk({ refusal }))
          const queues = calls.map((call, index) => {
            const parts = pieces(call.arguments, call.cuts)
            return [
              {
                tool_calls: [
                  {
                    index,
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: parts[0] ?? "" }
                  }
                ]
              },
              ...parts
                .slice(1)
                .map((part) => ({ tool_calls: [{ index, function: { arguments: part } }] }))
            ]
          })
          const started = new Set<number>()
          for (const pick of order) {
            const open = queues.flatMap((queue, index) =>
              queue.length > 0 && (started.has(index) || index === started.size) ? [index] : []
            )
            if (open.length === 0) break
            const index = open[pick % open.length] ?? 0
            started.add(index)
            frames.push(chunk(queues[index]?.shift()))
          }
          for (const queue of queues) for (const delta of queue) frames.push(chunk(delta))
          frames.push(chunk({}, calls.length === 0 ? "stop" : "tool_calls"), "[DONE]")

          const transport = scriptedFetch([
            () => sseResponse(frames),
            () => sseResponse([chunk({ content: "Next." }), chunk({}, "stop"), "[DONE]"])
          ])
          const provider = makeChatCompletionsProvider({
            providerId: "router",
            baseUrl: "https://router.test/v1",
            fetch: transport.fetch
          })
          const first = completionOf(
            await collect(provider.stream(request([{ role: ROLE.user, content: "Q" }])))
          )
          await collect(
            provider.stream(
              request([
                { role: ROLE.user, content: "Q" },
                stored(first),
                ...toolOutputs(calls.map((call) => call.id))
              ])
            )
          )

          const details = [
            ...(summary === undefined || summary[0] === ""
              ? []
              : [{ type: "reasoning.summary", summary: summary[0], index: 0, format }]),
            ...(encrypted === undefined
              ? []
              : [{ type: "reasoning.encrypted", data: encrypted, id: "rs_1", index: 1, format }])
          ]
          const sent = recordsOf(recordOf(transport.requests[1]?.body).messages).filter(
            (message) => message.role === ROLE.assistant
          )
          const written = content + (refusal ?? "")
          const expected =
            written === "" && calls.length === 0 && details.length === 0
              ? []
              : [
                  {
                    role: ROLE.assistant,
                    content: written,
                    ...(calls.length === 0
                      ? {}
                      : {
                          tool_calls: calls.map((call) => ({
                            id: call.id,
                            type: "function",
                            function: { name: call.name, arguments: call.arguments }
                          }))
                        }),
                    ...(details.length === 0 ? {} : { reasoning_details: details })
                  }
                ]
          expect(sent.map(withParsedArguments)).toEqual(expected.map(withParsedArguments))
          expect(
            recordsOf(recordOf(transport.requests[1]?.body).messages).filter(
              (message) => message.role === ROLE.tool
            )
          ).toEqual(toolOutputs(calls.map((call) => call.id)))
        }
      ),
      { numRuns: 200 }
    )
  })
})

describe("OpenAI Responses: every output item comes back unchanged on the next turn", () => {
  const staticAuth = { headers: async () => ({ authorization: "Bearer token-1" }) }

  const reasoningItem = fc.record({
    kind: fc.constant("reasoning" as const),
    summary: fc.array(text, { maxLength: 2 }),
    encrypted: fc.option(fc.stringMatching(/^[A-Za-z0-9+/=]{1,40}$/), { nil: undefined })
  })
  const messagePart = fc.oneof(
    text.map((value) => ({ type: "output_text", text: value, annotations: [] })),
    text.map((value) => ({ type: "refusal", refusal: value }))
  )
  const messageItem = fc.record({
    kind: fc.constant("message" as const),
    parts: fc.array(messagePart, { minLength: 1, maxLength: 3 }),
    phase: fc.option(fc.constantFrom("commentary", "final_answer"), { nil: undefined })
  })
  const callItem = fc.record({
    kind: fc.constant("function_call" as const),
    name: toolName,
    arguments: argumentsJson
  })

  it("keeps reasoning, messages and function calls with their ids, in order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(reasoningItem, messageItem, callItem), { minLength: 1, maxLength: 5 }),
        async (drawn) => {
          const output = drawn.map((item, index) => {
            if (item.kind === "reasoning")
              return {
                type: "reasoning",
                id: `rs_${index}`,
                summary: item.summary.map((part) => ({ type: "summary_text", text: part })),
                ...(item.encrypted === undefined ? {} : { encrypted_content: item.encrypted })
              }
            if (item.kind === "message")
              return {
                type: "message",
                id: `msg_${index}`,
                role: ROLE.assistant,
                status: "completed",
                content: item.parts,
                ...(item.phase === undefined ? {} : { phase: item.phase })
              }
            return {
              type: "function_call",
              id: `fc_${index}`,
              call_id: `call_${index}`,
              name: item.name,
              arguments: item.arguments,
              status: "completed"
            }
          })
          const completed = (id: string, items: ReadonlyArray<unknown>) => ({
            type: "response.completed",
            response: {
              id,
              output: items,
              usage: {
                input_tokens: 1,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 1
              }
            }
          })
          const transport = scriptedFetch([
            () => sseResponse([completed("resp-1", output)]),
            () =>
              sseResponse([
                completed("resp-2", [
                  {
                    type: "message",
                    id: "msg_next",
                    role: ROLE.assistant,
                    status: "completed",
                    content: [{ type: "output_text", text: "Next.", annotations: [] }]
                  }
                ])
              ])
          ])
          const provider = makeOpenAiResponsesProvider({ auth: staticAuth, fetch: transport.fetch })
          const first = completionOf(
            await collect(provider.stream(request([{ role: ROLE.user, content: "Q" }])))
          )
          const calls = (first.message.tool_calls ?? []).map((call) => call.id)
          expect(calls).toEqual(
            output.flatMap((item) => (item.type === "function_call" ? [String(item.call_id)] : []))
          )
          await collect(
            provider.stream(
              request([{ role: ROLE.user, content: "Q" }, stored(first), ...toolOutputs(calls)])
            )
          )

          const replayed = recordsOf(recordOf(transport.requests[1]?.body).input).filter((item) =>
            ["reasoning", "message", "function_call"].includes(String(item.type))
          )
          const essence = (item: Readonly<Record<string, unknown>>) => {
            if (item.type === "reasoning")
              return {
                type: item.type,
                id: item.id,
                summary: item.summary,
                encrypted_content: item.encrypted_content
              }
            if (item.type === "message")
              return {
                type: item.type,
                id: item.id,
                phase: item.phase,
                content: recordsOf(item.content).map((part) => ({
                  type: part.type,
                  text: part.text,
                  refusal: part.refusal
                }))
              }
            return {
              type: item.type,
              id: item.id,
              call_id: item.call_id,
              name: item.name,
              arguments: item.arguments
            }
          }
          expect(replayed.map(essence)).toEqual(output.map((item) => essence(item)))
          expect(
            recordsOf(recordOf(transport.requests[1]?.body).input)
              .filter((item) => item.type === "function_call_output")
              .map((item) => ({ call_id: item.call_id, output: item.output }))
          ).toEqual(calls.map((id) => ({ call_id: id, output: `out ${id}` })))
        }
      ),
      { numRuns: 200 }
    )
  })

  it("keeps text that arrived only as deltas when the final snapshot lists no items", async () => {
    await fc.assert(
      fc.asyncProperty(
        text.filter((value) => value !== ""),
        cuts,
        async (written, writtenCuts) => {
          const transport = scriptedFetch([
            () =>
              sseResponse([
                ...pieces(written, writtenCuts).map((piece) => ({
                  type: "response.output_text.delta",
                  output_index: 0,
                  delta: piece
                })),
                {
                  type: "response.completed",
                  response: {
                    id: "resp-1",
                    output: [],
                    usage: {
                      input_tokens: 1,
                      input_tokens_details: { cached_tokens: 0 },
                      output_tokens: 1
                    }
                  }
                }
              ]),
            () =>
              sseResponse([
                {
                  type: "response.completed",
                  response: {
                    id: "resp-2",
                    output: [],
                    usage: {
                      input_tokens: 1,
                      input_tokens_details: { cached_tokens: 0 },
                      output_tokens: 1
                    }
                  }
                }
              ])
          ])
          const provider = makeOpenAiResponsesProvider({ auth: staticAuth, fetch: transport.fetch })
          const first = completionOf(
            await collect(provider.stream(request([{ role: ROLE.user, content: "Q" }])))
          )
          await collect(
            provider.stream(request([{ role: ROLE.user, content: "Q" }, stored(first)]))
          )
          const assistant = recordsOf(recordOf(transport.requests[1]?.body).input).filter(
            (item) => item.role === ROLE.assistant || item.type === "message"
          )
          const replayedText = assistant
            .flatMap((item) =>
              typeof item.content === "string"
                ? [item.content]
                : recordsOf(item.content).map((part) => String(part.text ?? ""))
            )
            .join("")
          expect(replayedText).toBe(written)
        }
      ),
      { numRuns: 100 }
    )
  })
})
