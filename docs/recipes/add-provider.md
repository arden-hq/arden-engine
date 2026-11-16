# Add a model provider or model server

Use this when the engine must send chat requests to a new upstream. Case 1, the common
one, is a new server on the Chat Completions wire, shown file by file with OpenRouter
(`4493fdf` settings and discovery, `425508c` start-up). Case 2, a new wire, is at the end.

## 1. Name the server

In `apps/server-ts/src/providers/chat-completions/discovery.ts`, add the name to
`CHAT_COMPLETIONS_SERVERS = ["llama.cpp", "openrouter", "generic"]`. The settings
file takes it as `provider.server`.

Run the typecheck from the check. It names the three places that need the name:
`CHAT_COMPLETIONS_HOSTS` in `apps/server-ts/src/providers/chat-completions/route.ts`
(the model list's group), `SERVER_NEEDS` in `apps/server-ts/src/serve/settings.ts`
(fields the settings must carry), and the switch in `discoverModels` in
`apps/server-ts/src/serve/models.ts`. `chatCompletionsRoute` needs nothing.

```ts
  openrouter: { id: "openrouter", name: "OpenRouter" },      // route.ts
  openrouter: ["model"],                                      // settings.ts
      case "openrouter": return await discoverOpenRouter(input, wanted ?? []) // models.ts
```

A server the settings name and nothing detects (a plain Chat Completions server):
share the `generic` case in `discoverModels`, give it `["model", "contextLimit"]` in
`SERVER_NEEDS`, and skip steps 2 and 3. `apps/server-ts/test/serve-settings.test.ts`
refuses a server name that does not exist; if yours takes that name, change the test's.

## 2. Detect and discover it

In `detectServer` (the step 1 file), know the server by its host or by an answer only
it gives: `if (new URL(input.baseUrl).hostname === "openrouter.ai") return "openrouter"`.
An explicit `server` in the settings always wins. Write a twin of `discoverOpenRouter`:
read the model list, decode each entry alone, return a `DiscoveredModel` per wanted id:

```ts
  if (!parameters.includes("tools"))
    throw new DiscoveryError({ reason: "no_tool_calls", server: "openrouter", model: model.id })
  return {
    id: model.id, contextLimit: smallest([model.context_length, model.top_provider?.context_length]),
    outputCap: positive(model.top_provider?.max_completion_tokens),
    reasoningEfforts: reasoning ? openRouterEfforts(model.reasoning ?? undefined) : [],
    compat: { maxTokensField: …, reasoningEffort: reasoning ? "openrouter" : "none", … } }
```

- Set each flag of `libs/loop/src/providers/chat-completions/compat.ts` from what the server reports or a live run showed, dated in a comment. Never branch on the provider id (`128010b`, `dc61667`).
- The window is what one request gets (llama.cpp `n_ctx`, not `n_ctx_train`); on a router, the smaller of the model's and its main route's.
- Fill `outputCap` where the server states one: a step writes at most the room the window leaves, never above it (`fb69717`, `08addb5`).
- Offer only the efforts the server takes, and `none` only where thinking can be turned off (`dc61667`).
- A wrong answer is a `DiscoveryError` with a typed reason; no answer is an `UnreachableError`, so a stopped server exits 3 as stopped (`56b7ea9`, `da41ece`).
- Discovery never loads a model or spends money: llama.cpp asks with `autoload=false`; OpenRouter's list needs no key.
- A key goes only over HTTPS or to this machine (`checkBaseUrl` in `settings.ts`). The settings name its variable (`apiKeyEnv`), never the key.

## 3. Record the server's answers

Save a real answer, cut to a few entries, as `apps/server-ts/test/fixtures/chat-completions/openrouter-models.json`
was. In `apps/server-ts/test/chat-completions-discovery.test.ts`, add a `detectServer`
case and a `describe` that pins each `DiscoveredModel` with `toEqual`. Take model ids
from the server's list today, not from memory (`f53b9ea`).

## 4. Offer it in the desktop, if asked

The desktop's saved model server has its own service list, out of the typecheck's
reach: `libs/protocol/src/model-endpoints/contracts.ts`, `libs/protocol/src/model-endpoints/schema.ts`,
`apps/server-ts/src/persistence/model-endpoints/store.ts`, and `SERVER_OF` plus the switch
in `apps/server-ts/src/models/endpoints/chat.ts`. Test: `apps/server-ts/test/model-server-check.test.ts`.

## Case 2: a new wire

Read "Writing a provider" in `libs/loop/README.md`. The example is `d51df8a`: an adapter
folder like `libs/loop/src/providers/chat-completions/` (`provider.ts`, `request.ts`,
`stream.ts`, `errors.ts`, `compat.ts`), an export in `libs/loop/package.json` and `libs/loop/src/index.ts`,
and `libs/loop/test/chat-completions.test.ts` with recorded chunks. The host adds a
`kind` in `settings.ts` and a route in `models.ts`.

- Use the kit in `libs/loop/src/providers/kit/` (`streamSse`, `classifyRejection`, `orderToolHistory`, `answerToolSearch`, `reportedCost`). A copy fails `libs/loop/test/provider-kit.test.ts`.
- Overflow: structured class, then 413, then the message on a 400; a throttle or quota never; a router's relayed body is read as the upstream's (`5359fad`, `8489bdf`). Add real bodies to `REJECTIONS`.
- Tool calls: a new id at an index in use starts a new call (`9556c7b`); retract a call the output limit cut (`d3a874b`); refuse a malformed entry, never skip it (`b1db6c7`).
- Usage: input tokens include cached and cache-written ones; OpenRouter's cached count excludes writes (`ac1c722`). Cost is only what the response reports, through `reportedCost`, never from a price table (`f6412d0`).
- Replay reasoning only on the route that wrote it; stamp the requested model beside the answering one (`3da9c33`).
- Providers import only the kit and the root contracts: run `bun run depcruise` from the repo root.

## Check

```bash
(cd apps/server-ts && bun run typecheck) \
  && (cd libs/loop && bunx vitest run test/chat-completions.test.ts test/provider-kit.test.ts) \
  && (cd apps/server-ts && bunx vitest run test/chat-completions-discovery.test.ts test/serve-models.test.ts test/serve-settings.test.ts test/model-server-check.test.ts)
```

It takes about 20 seconds and must end with:

```
 Test Files  4 passed (4)
```

- `Property '<name>' is missing in type` (`route.ts`, `settings.ts`) or `Function lacks ending return statement` (`models.ts`): step 1 is not done.
- A `toEqual` diff in the discovery test: a flag, window or effort differs from the fixture (step 2).
- `keeps shared provider machinery in the kit only`: an adapter copies kit code (case 2).
- `a configured server starts with its settings in place`: the server does not boot. Read the cause; it may be another change in the tree.

The offline check never talks to a real server. Run the live check once by hand. It
needs a running server, or a key for a hosted one, which costs money:

```bash
CHAT_COMPLETIONS_BASE_URL=http://127.0.0.1:9931/v1 \
CHAT_COMPLETIONS_MODEL=ggml-org/gemma-4-E2B-it-GGUF:Q8_0 \
CHAT_COMPLETIONS_COMPAT='{"structuredOutput":"json_schema","parallelToolCalls":true,"toolChoiceNone":"unenforced"}' \
bun --conditions=arden-source libs/loop/test/live/chat-completions.live.ts
```

It prints `PASS` or `FAIL` per case and exits 0 only when all pass. For a key, set
`CHAT_COMPLETIONS_API_KEY_ENV` to its variable's name. Then run "To check a local model
end to end" in `apps/server-ts/README.md` and record the date and models there.
