import { ROLE } from "@arden-hq/std/message-vocabulary"
import { describe, expect, it } from "vitest"

import type { ChatMessage } from "../src/contracts/messages.js"
import { MISSING_TOOL_OUTPUT } from "../src/providers/kit/index.js"
import { collect } from "./kit.js"
import {
  GEMMA,
  answered,
  call,
  provider,
  request,
  sentMessages,
  weather
} from "./chat-completions-kit.js"

describe("Chat Completions request body", () => {
  it("orders a multi-turn tool history: outputs follow calls, context waits, an interrupted call is closed", async () => {
    const { provider: cc, transport } = provider([answered("Ok.")])
    const history: ReadonlyArray<ChatMessage> = [
      { role: ROLE.system, content: "Base prompt." },
      { role: ROLE.system, content: "Background note." },
      {
        role: ROLE.user,
        content: [
          { type: "text", text: "Check both." },
          { type: "context", content_type: "page", content: "Body", metadata: { slug: "home" } }
        ]
      },
      {
        role: ROLE.assistant,
        content: "",
        reasoning_content: "Plan.",
        tool_calls: [call("call-a"), call("call-b", "Rome")]
      },
      { role: ROLE.tool, tool_call_id: "call-a", content: "A out" },
      { role: ROLE.developer, content: "Current run context" },
      { role: ROLE.user, content: "Steering while b runs" },
      { role: ROLE.tool, tool_call_id: "call-b", content: "B out" },
      { role: ROLE.assistant, content: "", reasoning_content: "Thinking only." },
      { role: ROLE.assistant, content: "Retrying.", tool_calls: [call("call-c")] },
      { role: ROLE.user, content: "Continue." }
    ]

    await collect(cc.stream(request({ messages: history, tools: [weather] })))

    expect(transport.requests[0]?.body).toEqual({
      model: GEMMA,
      messages: [
        { role: ROLE.system, content: "Base prompt.\n\nBackground note." },
        {
          role: ROLE.user,
          content: [
            { type: "text", text: "Check both." },
            { type: "text", text: '<page slug="home">\nBody\n</page>' }
          ]
        },
        { role: ROLE.assistant, content: "", tool_calls: [call("call-a"), call("call-b", "Rome")] },
        { role: ROLE.tool, tool_call_id: "call-a", content: "A out" },
        { role: ROLE.tool, tool_call_id: "call-b", content: "B out" },
        { role: ROLE.system, content: "Current run context" },
        { role: ROLE.user, content: "Steering while b runs" },
        { role: ROLE.assistant, content: "Retrying.", tool_calls: [call("call-c")] },
        { role: ROLE.tool, tool_call_id: "call-c", content: MISSING_TOOL_OUTPUT },
        { role: ROLE.user, content: "Continue." }
      ],
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: weather }]
    })
  })

  const flagged = {
    model: GEMMA,
    messages: [
      { role: ROLE.system, content: "Base." },
      { role: ROLE.user, content: "Hi." },
      { role: ROLE.assistant, content: "Hello." },
      { role: ROLE.user, content: "Again." }
    ] satisfies ReadonlyArray<ChatMessage>,
    tools: [weather],
    toolChoice: "required" as const,
    maxOutputTokens: 256,
    reasoningEffort: "high"
  }

  it.each([
    {
      compat: {},
      extra: {},
      body: {
        model: GEMMA,
        messages: flagged.messages,
        stream: true,
        stream_options: { include_usage: true },
        tools: [{ type: "function", function: weather }],
        tool_choice: "required",
        max_completion_tokens: 256
      }
    },
    {
      compat: {
        maxTokensField: "max_tokens",
        systemRole: "developer",
        reasoningEffort: "openrouter",
        structuredOutput: "json_schema",
        imageInput: true,
        parallelToolCalls: true,
        cacheControl: "anthropic"
      } as const,
      extra: {
        responseFormat: { name: "reading", schema: { type: "object" } },
        messages: [
          ...flagged.messages.slice(0, 3),
          {
            role: ROLE.user,
            content: [
              { type: "image", media_type: "image/png", data: "iVBOR" },
              { type: "text", text: "Again." }
            ]
          }
        ] satisfies ReadonlyArray<ChatMessage>
      },
      body: {
        provider: { order: ["anthropic"] },
        model: GEMMA,
        messages: [
          {
            role: ROLE.developer,
            content: [{ type: "text", text: "Base.", cache_control: { type: "ephemeral" } }]
          },
          { role: ROLE.user, content: "Hi." },
          { role: ROLE.assistant, content: "Hello." },
          {
            role: ROLE.user,
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } },
              { type: "text", text: "Again.", cache_control: { type: "ephemeral" } }
            ]
          }
        ],
        stream: true,
        stream_options: { include_usage: true },
        tools: [{ type: "function", function: weather, cache_control: { type: "ephemeral" } }],
        tool_choice: "required",
        parallel_tool_calls: true,
        max_tokens: 256,
        reasoning: { effort: "high" },
        response_format: {
          type: "json_schema",
          json_schema: { name: "reading", schema: { type: "object" }, strict: true }
        }
      }
    }
  ])("sends compat $compat as its documented body", async ({ compat, extra, body }) => {
    const { provider: cc, transport } = provider([answered("Ok.")], {
      compat,
      ...("responseFormat" in extra ? { extraBody: { provider: { order: ["anthropic"] } } } : {})
    })
    await collect(cc.stream(request({ ...flagged, ...extra })))
    expect(transport.requests[0]?.body).toEqual(body)
  })

  it("tells a model without image input that an image was left out, instead of failing every request", async () => {
    const { provider: cc, transport } = provider([answered("I cannot see it.")])
    const image: ChatMessage = {
      role: ROLE.user,
      content: [
        { type: "text", text: "What is this?" },
        { type: "image", media_type: "image/png", data: "iVBOR" }
      ]
    }
    await collect(cc.stream(request({ messages: [image] })))
    expect(sentMessages(transport.requests[0]?.body)).toEqual([
      {
        role: ROLE.user,
        content: [
          { type: "text", text: "What is this?" },
          { type: "text", text: "(image omitted: this model does not take image input)" }
        ]
      }
    ])
  })
})
