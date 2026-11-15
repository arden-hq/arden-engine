# `@arden-hq/loop`

A runtime for tool-calling agents. It works with any model provider.

The loop takes a model provider, a toolset and a message history. It runs model turns and tool calls until the model ends its turn or a budget stops the run. It gives every event to the host as a typed stream.

The package is plain TypeScript. It has no Effect and no schema library. Its one runtime dependency is `eventsource-parser`. It is ESM only and needs Node.js 20.19 or later.

## Exports

| Import | What it gives you |
| --- | --- |
| `@arden-hq/loop` | `makeAgent`, `createTool`, `createToolset`, the error classes, budgets and all contract types |
| `@arden-hq/loop/providers/openai-responses` | `makeOpenAiResponsesProvider`, the OpenAI Responses provider |
| `@arden-hq/loop/providers/chat-completions` | `makeChatCompletionsProvider`, the OpenAI-compatible Chat Completions provider (llama.cpp, OpenRouter, any compatible server) |
| `@arden-hq/loop/provider-kit` | The streamed-request loop, retry, SSE, rejection classification, tool-history ordering and abort helpers for writing another provider |

The server (`@arden-hq/server`) and the CLI use it. Desktop and iOS do not import it.

## Quick start

```ts
import { createTool, createToolset, makeAgent } from "@arden-hq/loop"
import { makeOpenAiResponsesProvider } from "@arden-hq/loop/providers/openai-responses"
import { z } from "zod"

const roll = createTool({
  name: "roll_die",
  description: "Roll a die with the given number of sides.",
  parameters: z.object({ sides: z.number().int().min(2) }),
  metadata: {},
  execute: async ({ sides }) => `You rolled a ${1 + Math.floor(Math.random() * sides)}`
})

const toolset = createToolset([roll], { toJsonSchema: z.toJSONSchema })
const provider = makeOpenAiResponsesProvider({
  auth: { headers: async () => ({ authorization: `Bearer ${process.env.OPENAI_API_KEY}` }) }
})

const agent = makeAgent({ model: "gpt-5.2" }, { provider, toolset: toolset() })
const result = await agent.run([{ role: "user", content: "Roll a d20." }])
console.log(result.text, result.stop_reason)
```

## Main ideas

- **Tools.** `createTool` takes a name, a description, a Standard Schema for the parameters, a `metadata` bag and `execute`. Bad model arguments never throw. The model gets a message that tells it how to fix the call. `createToolset` binds a tool list to one run. The host gives it the schema-to-JSON-Schema function once.
- **Metadata keys the loop reads.** `approval`, `background`, `detached`, `changes_state`, `concurrency_group`, `deferred`, `ends_turn`, `hosted`. A state-changing tool takes the write side of a fair read/write lock. Calls in one `concurrency_group` run one at a time.
- **Streaming.** `agent.stream()` yields `AgentEvent` values with a `_tag`, then one `Result` without a `_tag`. Closing the iterator cancels the run, the model request and all running tools.
- **Structured output.** Pass `output: { schema, toJsonSchema }` to `run` or `stream`. The loop validates the last text. It makes one correction retry, then fails with `StructuredOutputError`.
- **Budgets.** `makeAgent` config accepts `maxIterations`, `maxToolCalls`, `maxWallTimeMs`, `maxCost`, `maxNoProgressSteps` and `maxToolConcurrency` (default 6). Each limit sets a `Result.stop_reason`. `makeRunBudget` builds a token budget that runs can share.
- **Errors.** All errors extend `LoopError` and carry a `_tag`. An abort is a plain `AbortError`, never a `LoopError`.
- **Output size.** `truncate` on `createToolset` cuts long tool results. It keeps the head and the tail.

## Durability

The loop keeps no state between calls. The host saves state through `AgentHooks`:

- `onStepFinish` runs after each model turn. Save the history here.
- `onCheckpoint` runs when launch and delivery records change.
- `getPendingMessages` runs before each model turn. It adds messages that arrived during the run.
- `recoverToolCalls` runs at start when the history ends with unresolved tool calls. Return the stored results for calls that already finished.

A pause is a stop. When a tool throws `PauseRequested`, the run ends with `stop_reason: "paused"` and a `paused_tools` list. To resume, run a new agent over the saved history. The host replays the recorded approval as `request.approval`.

## Streaming tool dispatch

A provider can emit `OutputItemReady` for each complete part of the answer. The loop saves each part as its own assistant record. It then starts ordinary tools at once, through the same approval, budget and cancellation path. Turn-ending tools wait for the full batch. A provider that emits only `Completed` gets batch execution.

If a transport retry happens after saved output, the loop does not replay it. The turn ends at the saved parts. The loop emits `ModelResponseReset`. The next step continues from their tool results.

## Background tools and steering

Every tool call has a foreground budget. It is `foregroundBudgetMs` of execution time. The default is 10000. `Infinity` turns it off. The time counts from when the effect starts. Waiting for a permit, a lock or an approval does not count.

A call that is still running after its budget moves to the background:

1. The batch settles the call with a launch receipt.
2. The same promise keeps running.
3. The result arrives later as a completion message.

Rules:

- `metadata.background: true` starts a tool in the background at once. Use it for lookups the model must not wait for. Do not add a per-tool flag for slow tools.
- Three kinds of tool never move. Hosted tools run at the provider. Turn-ending tools must stand alone. Tools that already return a job handle (a child agent, a workflow, a detached process) declare `metadata.detached: true`. `createTool` refuses `background` on all three.
- State-changing calls (`changes_state`) share one run-wide queue. They start one at a time, in the order the model asked for them. A call holds the queue until it settles or moves to the background. A moved call keeps its concurrency-group lock until it really settles.
- At most `maxToolConcurrency` background calls can wait for delivery. Extra calls get a retryable error and do not start.
- Before each model request, the loop waits up to `backgroundGraceMs` (default 1000) for calls it just launched. A quick call then delivers its result in that request.
- A pause does not cancel background calls. The loop hands them to `hooks.holdBackgroundCalls`. A resumed run asks `hooks.claimBackgroundCalls` for the calls still alive in the process. Calls lost to a restart go to `recoverToolCalls`.
- Cancel or stop aborts all background calls. A new message never cancels one.
- `pendingBackgroundCalls(messages)` lists unresolved calls, for compaction guards.

Hosts with queued input expose `hooks.hasPendingInput`. The loop checks it just before dispatch. When input waits, unstarted calls get a retryable refusal. Started calls keep running. The next model boundary adds the input to the same run. `ToolCallRequest.beforeExecute` and `ToolContext.beforeExecute` carry this check through locks, approval gates and nested tools. A custom toolset must call it after its own waits.

Provider capabilities choose `asyncTools: "native" | "message"`. The message strategy returns a launch receipt, then adds an `is_meta` completion message. The host turns on native async and WebSocket steering for routes it has verified. Every other route uses message delivery and steering at step boundaries. Resolve capabilities for the actual route with `resolveModelCapabilities`. Do not assume that a private endpoint supports all native features.

A provider may implement `openSession()` for invocation-local transport state. The Responses provider takes a host `connectWebSocket` function. It then owns steering, successors and continuations. Without it, input enters at step boundaries.

## Writing a provider

A `ModelProvider` has a `stream(request)` function. It returns tagged items: `TextDelta`, `ReasoningDelta`, `ToolCallDelta`, `ProviderToolCall`, `ProviderStreamRetry` and one final `Completed`. Providers import only the kit and the root contracts. They never import `agent/`, `tools/` or `internal/`. A dependency-cruiser rule holds this.

The provider owns prompt caching, replay state and transport retry. The host owns credentials. A factory only calls `auth.headers()` for each connection attempt.

One implementation per concern, in the kit, so every adapter behaves the same:

- `streamSse` is the connection loop: auth headers per attempt, one forced refresh on a 401 before anything was emitted, the error body read into the failure, the idle timeout, and the bounded retry announced by `ProviderStreamRetry`. An adapter supplies the URL, the body and an event mapper.
- `classifyRejection` maps a refusal to a `ProviderErrorCode`. It holds the one table of context-overflow and model-unavailable wordings for every server we talk to.
- `orderToolHistory` puts each tool output right after its call, holds context back while calls are pending, and closes an interrupted call with a "not recorded" output.
- `contextBlockText` is how a `context` block reads to a model on any wire.
- `answerToolSearch` answers a client tool search: it reads the arguments (malformed ones get a correction the model can act on), runs `ToolSearch.search`, and writes the result text and `loaded_tool_names` the history keeps. `TOOL_SEARCH_TOOL_NAME` is the search's name on every wire.
- `loadedToolNames` (in the contracts, shared with the loop) is which deferred tools a history has loaded, read only from provider-neutral fields: `provider_tool_calls[].loaded_tool_names` and `developer` records' `loaded_tools` / `removed_tools`.

`test/provider-kit.test.ts` fails when an adapter grows its own copy of one of these.

### Origin and replay

Every assistant answer carries `origin: { provider, api, model }`: who served it, which wire, and the model that actually answered (a router can answer with another model than the one requested). The loop persists it untouched beside `provider_state`.

An adapter reads both to decide what it sends back on a later request:

- Chat Completions sends a stored `provider_state["chat-completions"].reasoning_details` back only when the turn's origin matches this provider id, this wire and the request's model (`sameOrigin`). Encrypted reasoning and signatures are bound to the issuer and model that wrote them; every reference agent drops them on a mismatch. Plain reasoning text is never sent back in `content`.
- Responses still replays its own `provider_state` whatever the origin. Whether OpenAI accepts encrypted reasoning across models is an open question; the stamp is there for when it is decided.
- A tool search crosses wires through its provider-neutral record. Chat Completions replays any search (its own or one Responses answered) as a call to `tool_search` plus a `tool` message with the stored `result`. Responses replays a search another wire answered as native `tool_search_call` / `tool_search_output` items, the tools looked up by `loaded_tool_names`; a turn Responses wrote itself without its stored items is still refused, since it cannot be rebuilt. Other provider calls (a hosted web search) have no form on the other wire; their results reached the model as the turn's text.

### Chat Completions

`makeChatCompletionsProvider({ providerId, baseUrl, auth?, compat? })` posts to `${baseUrl}/chat/completions`. Servers differ only through the `compat` flags (`ChatCompletionsCompat`; each flag's comment says what it changes and which server needs it), never through a branch on `providerId`. Typical settings:

- llama.cpp `llama-server`: `{ structuredOutput: "json_schema", parallelToolCalls: true }`, plus `imageInput: true` with a multimodal projector. No `auth`.
- OpenRouter: `{ reasoningEffort: "openrouter", structuredOutput: "json_schema" }`, plus `cacheControl: "anthropic"` for Claude models; routing preferences go in `extraBody: { provider: … }`.

The provider emits only `Completed`, so the loop runs a turn's tool calls as one batch. A system or developer message inside the conversation is sent in place, in the route's one instruction role.

Tool search runs on the client (`toolSearch: "client"`). The wire has no search item, so the adapter declares the search as an ordinary function tool beside the core tools, plus every deferred tool the history has loaded (`loadedToolNames`), appended in load order. When the model calls it, the adapter answers with `answerToolSearch`, streams the call as a `ProviderToolCall`, records it in `provider_tool_calls`, and marks the response `continuation` (the model waits for the result, as with Responses' `end_turn: false`). Ordinary calls in the same response stay runtime calls.

The cost on llama.cpp: the chat template renders tools before the conversation, and the server reuses its KV cache only up to the first differing token, so a load re-reads the conversation so far plus the new declaration; a step without a load reuses everything. Measured with gemma-4-E2B Q8_0 on b12359, 41 deferred tools: 3,143 prompt tokens with every tool declared, 525 with search; the step after loading one tool read 159 new tokens (669 cached), the next step 51 (825 cached). Arden's own tool set at 16k context: about 14,100 tokens with search (system and runtime messages 4,700, 22 core tools 8,350, the search tool 1,080 of which the catalog listing about 840) against about 56,000 without.

The live check drives the real loop against a server; it is not part of `bun run test`:

```bash
CHAT_COMPLETIONS_BASE_URL=http://127.0.0.1:9931/v1 \
CHAT_COMPLETIONS_MODEL=ggml-org/gemma-4-E2B-it-GGUF:Q8_0 \
CHAT_COMPLETIONS_COMPAT='{"structuredOutput":"json_schema","imageInput":true,"parallelToolCalls":true}' \
bun --conditions=arden-source libs/loop/test/live/chat-completions.live.ts
```

The script's header lists the other variables (an API key variable name, a reasoning effort, the overflow prompt size, cases to skip).

## Layout

- `src/agent/` holds `makeAgent`, the run loop, budgets, recovery and background tools.
- `src/tools/` holds `createTool`, `createToolset` and dispatch.
- `src/contracts/` holds the message, tool, provider and event types.
- `src/providers/kit/` holds the provider kit; `src/providers/openai-responses/` and `src/providers/chat-completions/` hold the two bundled providers.
- `src/internal/` holds locks, the event queue and validation.

## Build

```bash
bun run build
bun run typecheck
bun run test
```

## License

Apache-2.0
