import { ROLE } from "@arden-hq/std/message-vocabulary"
import { describe, expect, it } from "vitest"

import type { AssistantMessage, ChatMessage } from "../src/contracts/messages.js"
import { makeAgent } from "../src/index.js"
import { makeOpenAiResponsesProvider } from "../src/providers/openai-responses/provider.js"
import { collect, completionOf, defined, recordOf, scriptedFetch, sseResponse } from "./kit.js"
import {
  GEMMA,
  SHELL_LOADED,
  answered,
  call,
  llamaChunk,
  mail,
  provider,
  searchChunk,
  searchRequest,
  searchTool,
  sentMessages,
  shell,
  weather,
  wire
} from "./chat-completions-kit.js"

describe("Chat Completions client tool search against Responses history", () => {
  it("replays the search exchange as a call and its result, and declares what it loaded", async () => {
    const { provider: cc, transport } = provider([
      () =>
        sseResponse([
          searchChunk("srch", '{"query":"shell"}'),
          llamaChunk({}, "tool_calls"),
          "[DONE]"
        ]),
      answered("Ok.")
    ])
    const first = completionOf(await collect(cc.stream(searchRequest())))
    const stored: AssistantMessage = {
      role: ROLE.assistant,
      content: "",
      provider_tool_calls: defined(first.message.provider_tool_calls ?? undefined, "a search"),
      output_parts: defined(first.message.output_parts ?? undefined, "output parts"),
      origin: defined(first.message.origin, "an origin")
    }
    await collect(
      cc.stream(searchRequest({ messages: [{ role: ROLE.user, content: "List files." }, stored] }))
    )

    expect(transport.requests[1]?.body).toEqual({
      model: GEMMA,
      messages: [
        { role: ROLE.user, content: "List files." },
        {
          role: ROLE.assistant,
          content: "",
          tool_calls: [
            {
              id: "srch",
              type: "function",
              function: { name: "tool_search", arguments: '{"query":"shell"}' }
            }
          ]
        },
        { role: ROLE.tool, tool_call_id: "srch", content: SHELL_LOADED }
      ],
      stream: true,
      stream_options: { include_usage: true },
      tools: [wire(weather), searchTool, wire(shell)]
    })
  })

  it("keeps the tools a Responses search loaded, and follows compaction and removal records", async () => {
    const responsesTurn: AssistantMessage = {
      role: ROLE.assistant,
      content: "",
      provider_tool_calls: [
        {
          id: "tsc_1",
          name: "tool_search",
          arguments: { query: "mail" },
          result: "Loaded: mail_send",
          done: true,
          loaded_tool_names: ["mail_send"],
          source_refs: []
        },
        {
          id: "ws_1",
          name: "web_search",
          arguments: { query: "news" },
          result: "",
          done: true,
          loaded_tool_names: [],
          source_refs: []
        }
      ],
      output_parts: [
        { type: "tool_call", tool_call_id: "ws_1", execution: "provider" },
        { type: "tool_call", tool_call_id: "tsc_1", execution: "provider" }
      ],
      provider_state: { "openai-responses": [{ type: "tool_search_call", id: "tsc_1" }] },
      origin: {
        provider: "openai",
        api: "openai-responses",
        model: "gpt-6.1-sol",
        requested_model: "gpt-6.1-sol"
      }
    }
    const { provider: cc, transport } = provider([answered("Ok."), answered("Ok.")])
    await collect(
      cc.stream(
        searchRequest({ messages: [{ role: ROLE.user, content: "Mail Bo." }, responsesTurn] })
      )
    )
    const compacted: ReadonlyArray<ChatMessage> = [
      { role: ROLE.user, content: "Summary of earlier work." },
      {
        role: ROLE.developer,
        content: "Tools still loaded from earlier in this conversation: mail_send, shell_run.",
        loaded_tools: ["shell_run", "mail_send"]
      },
      {
        role: ROLE.developer,
        content: "Tools changed in this conversation. No longer available: shell_run.",
        removed_tools: ["shell_run"]
      },
      { role: ROLE.user, content: "Go on." }
    ]
    await collect(cc.stream(searchRequest({ messages: compacted })))

    expect(transport.requests.map((sent) => recordOf(sent.body).messages)).toEqual([
      [
        { role: ROLE.user, content: "Mail Bo." },
        {
          role: ROLE.assistant,
          content: "",
          tool_calls: [
            {
              id: "tsc_1",
              type: "function",
              function: { name: "tool_search", arguments: '{"query":"mail"}' }
            }
          ]
        },
        { role: ROLE.tool, tool_call_id: "tsc_1", content: "Loaded: mail_send" }
      ],
      [
        { role: ROLE.user, content: "Summary of earlier work." },
        {
          role: ROLE.system,
          content: "Tools still loaded from earlier in this conversation: mail_send, shell_run."
        },
        {
          role: ROLE.system,
          content: "Tools changed in this conversation. No longer available: shell_run."
        },
        { role: ROLE.user, content: "Go on." }
      ]
    ])
    expect(transport.requests.map((sent) => recordOf(sent.body).tools)).toEqual([
      [wire(weather), searchTool, wire(mail)],
      [wire(weather), searchTool, wire(mail)]
    ])
  })

  it("replays a search answered here on the Responses wire as native search items", async () => {
    const chatTurn: AssistantMessage = {
      role: ROLE.assistant,
      content: "Looking.",
      provider_tool_calls: [
        {
          id: "srch",
          name: "tool_search",
          arguments: { query: "shell" },
          result: SHELL_LOADED,
          done: true,
          loaded_tool_names: ["shell_run"],
          source_refs: []
        }
      ],
      origin: {
        provider: "llama.cpp",
        api: "chat-completions",
        model: GEMMA,
        requested_model: GEMMA
      }
    }
    const transport = scriptedFetch([
      () =>
        sseResponse([
          { type: "response.completed", response: { output: [], usage: null, end_turn: true } }
        ])
    ])
    const responses = makeOpenAiResponsesProvider({
      auth: { headers: async () => ({ authorization: "Bearer t" }) },
      fetch: transport.fetch
    })
    const messages: ReadonlyArray<ChatMessage> = [
      { role: ROLE.user, content: "List files." },
      chatTurn,
      { role: ROLE.user, content: "Again." }
    ]
    await collect(responses.stream(searchRequest({ model: "gpt-6.1-sol", messages })))
    expect(recordOf(transport.requests[0]?.body).input).toEqual([
      { role: ROLE.user, content: "List files." },
      { role: ROLE.assistant, content: "Looking." },
      {
        type: "tool_search_call",
        call_id: "srch",
        execution: "client",
        status: "completed",
        arguments: { query: "shell" }
      },
      {
        type: "tool_search_output",
        call_id: "srch",
        execution: "client",
        status: "completed",
        tools: [
          {
            type: "namespace",
            name: "system",
            description: "Tools in the system namespace.",
            tools: [
              {
                type: "function",
                name: "shell_run",
                description: shell.description,
                parameters: shell.parameters,
                strict: false,
                defer_loading: true
              }
            ]
          }
        ]
      },
      { role: ROLE.user, content: "Again." }
    ])

    const ownTurnWithoutItems: AssistantMessage = {
      ...chatTurn,
      origin: {
        provider: "openai",
        api: "openai-responses",
        model: "gpt-6.1-sol",
        requested_model: "gpt-6.1-sol"
      }
    }
    await expect(
      responses.stream(
        searchRequest({
          model: "gpt-6.1-sol",
          messages: [messages[0] as ChatMessage, ownTurnWithoutItems]
        })
      )
    ).rejects.toThrow()
  })

  it("runs search, then the loaded tool, then the answer through makeAgent", async () => {
    const { provider: cc, transport } = provider([
      () =>
        sseResponse([
          searchChunk("srch", '{"query":"shell command"}'),
          llamaChunk({}, "tool_calls"),
          "[DONE]"
        ]),
      () =>
        sseResponse([
          llamaChunk({
            tool_calls: [
              {
                index: 0,
                id: "run1",
                function: { name: "shell_run", arguments: '{"command":"ls"}' }
              }
            ]
          }),
          llamaChunk({}, "tool_calls"),
          "[DONE]"
        ]),
      answered("Two files: a.txt and b.txt.")
    ])
    const executed: Array<string> = []
    const result = await makeAgent(
      { model: GEMMA },
      {
        provider: cc,
        toolset: {
          entries: () =>
            [weather, shell, mail].map((tool) => ({
              description: tool.description,
              parameters: tool.parameters,
              meta: {
                name: tool.name,
                ...("group" in tool ? { deferred: true, group: tool.group } : {})
              }
            })),
          loadedNames: () => new Set(),
          load: () => {},
          execute: (call) => {
            executed.push(`${call.name} ${JSON.stringify(call.args)}`)
            return { content: "a.txt\nb.txt", preview: "2 files" }
          }
        }
      }
    ).run([{ role: ROLE.user, content: "List my files." }])

    expect(result.text).toBe("Two files: a.txt and b.txt.")
    expect(executed).toEqual(['shell_run {"command":"ls"}'])
    const sent = transport.requests.map((request) => recordOf(request.body))
    expect(
      sent.map((body) =>
        (body.tools as ReadonlyArray<{ function: { name: string } }>).map(
          (tool) => tool.function.name
        )
      )
    ).toEqual([
      ["weather", "tool_search"],
      ["weather", "tool_search", "shell_run"],
      ["weather", "tool_search", "shell_run"]
    ])
    expect((sentMessages(sent[2]) as ReadonlyArray<unknown>).slice(1)).toEqual([
      { role: ROLE.user, content: "List my files." },
      {
        role: ROLE.assistant,
        content: "",
        tool_calls: [
          {
            id: "srch",
            type: "function",
            function: { name: "tool_search", arguments: '{"query":"shell command"}' }
          }
        ]
      },
      {
        role: ROLE.tool,
        tool_call_id: "srch",
        content: SHELL_LOADED
      },
      {
        role: ROLE.assistant,
        content: "",
        tool_calls: [
          {
            id: "run1",
            type: "function",
            function: { name: "shell_run", arguments: '{"command":"ls"}' }
          }
        ]
      },
      { role: ROLE.tool, tool_call_id: "run1", content: "a.txt\nb.txt" }
    ])
  })
})
