# `@arden-hq/loop`

A runtime for tool-calling agents. It works with any model provider.

The loop takes a model provider, a toolset and a message history. It runs model turns and tool calls until the model ends its turn or a budget stops the run. It gives every event to the host as a typed stream.

The package is plain TypeScript. It has no Effect and no schema library. Its one runtime dependency is `eventsource-parser`. It is ESM only and needs Node.js 20.19 or later.

## Exports

| Import | What it gives you |
| --- | --- |
| `@arden-hq/loop` | `makeAgent`, `createTool`, `createToolset`, the error classes, budgets and all contract types |
| `@arden-hq/loop/providers/openai-responses` | `makeOpenAiResponsesProvider`, the one bundled provider |
| `@arden-hq/loop/provider-kit` | Retry, SSE and abort helpers for writing another provider |

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

The provider owns prompt caching, replay state and transport retry. The host owns credentials. The Responses factory only calls `auth.headers()` for each connection attempt.

## Layout

- `src/agent/` holds `makeAgent`, the run loop, budgets, recovery and background tools.
- `src/tools/` holds `createTool`, `createToolset` and dispatch.
- `src/contracts/` holds the message, tool, provider and event types.
- `src/providers/kit/` and `src/providers/openai-responses/` hold the two provider entry points.
- `src/internal/` holds locks, the event queue and validation.

## Build

```bash
bun run build
bun run typecheck
bun run test
```

## License

Apache-2.0
