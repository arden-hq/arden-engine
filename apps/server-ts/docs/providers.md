# Model providers

Reference for the `provider` field of the settings file. The short version is in the [server README](../README.md).

## Provider kinds

`responses` is any OpenAI Responses endpoint (`baseUrl`, `apiKeyEnv`; needs `model` and `contextLimit`). `chat-completions` is any OpenAI Chat Completions endpoint: llama.cpp's `llama-server`, OpenRouter, or another. `apiKeyEnv` is optional (a local server has no key). `server` (`llama.cpp`, `openrouter`, `generic`) is detected at start when absent: `openrouter.ai` by its host, llama.cpp by `GET /props`. llama.cpp and OpenRouter report each model's context window, reasoning efforts and request shape; `contextLimit` may only lower that window. A llama.cpp server with one model needs no `model`; OpenRouter needs `model`; a generic server needs `model` and `contextLimit`. `codex` and `codex-login` use a Codex account.

```json
{ "provider": { "kind": "chat-completions", "baseUrl": "http://127.0.0.1:8080/v1" } }
{ "provider": { "kind": "chat-completions", "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }, "model": "openai/gpt-6-luna" }
```

## Keys and plain HTTP

A key never crosses the network in clear text: a provider that sends one (`apiKeyEnv`, always set on `responses`) needs an HTTPS `baseUrl` or plain HTTP to this machine (`localhost`, `127.0.0.1`, `::1`). A provider with no key may use plain HTTP to any host, such as a llama.cpp on the Docker host (`http://host.docker.internal:8080/v1`) or on the LAN; without HTTPS the chats themselves are readable on that network. A key over plain HTTP to another host is refused: use HTTPS, or remove `apiKeyEnv` if the server needs none.

## Tool search and the context window

A Chat Completions route searches tools on the client, as the Responses route does: the model is offered the core tools and one search tool, and a found tool is declared from the next request on. Measured on llama.cpp b12359 with Gemma 4 on 2026-11-16, the first request is about 14,100 tokens: 8,400 for the 22 core tools, 4,600 for the system prompt and runtime context, 1,100 for the search tool. With `toolSearch: false` every tool is declared and the request is about 56,000 tokens. A window near the request size compacts after every step, so give a local model at least 32,768 tokens, or offer fewer tools with `tools`. A model with a smaller window than the request fails with `context_length_exceeded`. A route whose model takes images (llama.cpp with a multimodal projector, an OpenRouter vision model) reports it, so `file_read` and attachments send images there at their stored size, converted to PNG or JPEG: neither server states limits to fit them to. A text-only route gets a note that an image was left out. To check a local model end to end:

```bash
llama-server -m model.gguf --ctx-size 32768 --port 8080 &
cat > /tmp/arden-cc/settings.json <<EOF
{ "dataDirectory": "/tmp/arden-cc/data", "workspace": "/tmp/arden-cc/work",
  "provider": { "kind": "chat-completions", "baseUrl": "http://127.0.0.1:8080/v1" },
  "tools": ["exec_command"], "approvalMode": "allow", "memory": false, "automations": false, "skillRoots": [] }
EOF
node apps/server-ts/dist/main.js --config /tmp/arden-cc/settings.json &   # prints the ready line
ARDEN_DIR=/tmp/arden-cc/data node apps/cli/dist/main.js run --output json "Run \`echo ok\` with exec_command and say what it printed."
sqlite3 /tmp/arden-cc/data/arden.db "select json_extract(message_json, '$.origin') from session_messages where role = 'assistant'"
```

## Output limit per step

One chat step may write at most the room the model's window leaves above its compaction trigger (20% of the window on a configured server: 6,554 tokens at 32,768), and never more than the model's own output cap where its server reports one (`chatStepOutputLimit` in `src/models/side-call.ts`, where the side jobs' limits below are chosen too). Without a limit llama.cpp writes until the window is full, and Gemma 4 E2B thought for 13,000 and 20,000+ tokens before one answer; compaction keeps a step's prompt under the trigger, so a step within this room cannot overflow the window by its own output. A step cut off at the limit ends with `length`: the run asks the model to continue in smaller steps, twice at most, then stops with `max_output_length`. Codex sends no limit, as before. A `responses` provider now sends this limit as `max_output_tokens`; its settings declare no output cap, and a server may refuse a limit above the model's own maximum, so keep `contextLimit` at most five times that maximum.

## Thinking and side jobs

Thinking counts against the output limit on every server, and a side job (a chat name, a task description, a review, triage, a compaction summary) has a small budget for its answer. So a one-answer side job runs at effort `none` where the model offers it, unless an effort is set for the helper model, and otherwise its limit leaves 4,096 more tokens for thinking, never more than the model's own output cap (OpenRouter's `max_completion_tokens`) (`src/models/side-call.ts`). A route that sends no output limit (Codex) keeps the model's default effort: thinking cannot cut its answer short. llama.cpp offers `none` for every model: the server turns the template's thinking off, so the chat may pick it too. OpenRouter offers it where the model's reasoning is not mandatory.

## OpenRouter

On OpenRouter (checked live on 2026-11-16: the loop's live cases on GPT-6 Luna, GPT-6.1 Sol, GPT-6 Astra, Claude Haiku 5.5, Claude Sonnet 5.5, Gemini 4 Hydrogen, Gemini 4 Carbon and DeepSeek V4.1 Flash 1017, and `exec` chats with shell, files, images, tool search and a model switch on GPT-6 Luna, GPT-6.1 Sol, Claude Haiku 5.5 and Gemini 4 Hydrogen) pick a `model` from `GET https://openrouter.ai/api/v1/models` whose `supported_parameters` list `tools`. The chat's efforts are the model's `supported_efforts`; OpenRouter refuses `none` where reasoning is mandatory and maps a level a model lacks to its nearest. Claude and Alibaba's Qwen models get `cache_control` breakpoints; the others cache by prefix on their own. An output limit above a model's own cap is clamped, not refused. A thinking model's signed reasoning (`reasoning_details`) goes back only to the model ID that wrote it, so a chat switched to another model (`PUT /sessions/:id/model`) sends that model the earlier answers' text and calls without the reasoning, and a switch back sends the reasoning again; the stored history keeps it either way. A refusal OpenRouter relays from the upstream ("Provider returned error") is classified by the upstream's own code and message: an Anthropic "prompt is too long" is `context_length_exceeded`. Detection knows OpenRouter by its host, so a proxy in front of it needs `"server": "openrouter"`.

## Cost

A cost is what the model provider reported charging, in US dollars, never an estimate: Arden keeps no price table. OpenRouter reports one on every response (`usage.cost`; with a provider key of your own, the upstream's bill plus OpenRouter's fee). llama.cpp, Codex and a `responses` endpoint that sends none report nothing. A Run's `result.cost` and `result.usage.cost` sum the Run's own model requests and are absent when any of them reported none, so a present cost is the whole spend and `0` is a reported `0`. Side jobs (chat names, step descriptions, compaction summaries) are not in a Run's cost: the usage file's `costUsd` covers every request of the data folder (`null` once one reported none, or ended before its usage arrived: a cancel, or a side job still running when `exec` stops the server, may be billed all the same; a refusal such as `context_length_exceeded` is not), and the usage report's daily cells carry `cost` the same way. Checked on 2026-11-16: an `exec` run on GPT-6.1 Sol reported $0.0887436, the sum of its 4 responses' `usage.cost`; on Claude Haiku 5.5 the usage file held exactly the sum of all 35 priced responses ($0.023845295); a llama.cpp run reported none.
