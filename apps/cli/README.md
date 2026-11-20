# `@arden-hq/cli`

The `arden` command. It sends work to a running Arden server and prints the result. A chat started here also appears in the Arden app.

It builds on `@arden-hq/headless` for the API calls.

## Install and run

```bash
npm install -g @arden-hq/cli
arden login
arden "Say hello"
```

It installs `@arden-hq/server` with it, which `serve`, `exec` and a bare prompt start.

From this repository:

```bash
bun install
just build
just arden exec "Say hello"
```

It stays `private` until its first manual publish; then `just release` publishes it with the other engine packages. To test it, run `bun run --cwd apps/cli test`.

## Commands

| Command | What it does |
| --- | --- |
| `arden <prompt>` | `arden run` when Arden or an `arden serve` is running, else `arden exec` with the default settings |
| `arden login` | Sign in with ChatGPT in the browser; the sign-in stays in `~/.arden-cli/chatgpt-login.json` (mode 0600). `--status` says whether you are signed in |
| `arden logout` | Forget that sign-in |
| `arden run [prompt]` | Send a prompt and wait for the answer. Piped stdin joins the prompt in a `<stdin>` block |
| `arden wait <run-id>` | Wait for a Run that is already going |
| `arden sessions` | List recent chats |
| `arden models` | List the models a new chat may run on: the ids `--model` takes |
| `arden serve [--config <file>]` | Start a server of its own from a settings file (default `~/.arden-cli/settings.json`, written on first use); runs until stopped |
| `arden exec [--config <file>] [prompt]` | Start that server, run one prompt on it, stop it |

Run `arden --help` for every option.

## Rules

- The server address is `--url` or `ARDEN_URL`.
- `serve` and `exec` take a settings file (`apps/server-ts/src/serve/settings.ts` lists every field) and a data folder of their own, never `~/.arden`. Reach a `serve` server with `ARDEN_DIR=<its dataDirectory> arden run ...`.
- `--output json` and `--output jsonl` print one `command_receipt`. Its `status` is `completed`, `submitted`, `failed`, `cancelled`, `interrupted` or `timed_out`.
- Exit codes, for every command, `serve` and `exec` included:

  | Code | Meaning | Receipt `error.code` |
  | --- | --- | --- |
  | `0` | completed or submitted | |
  | `1` | failed or cancelled; for `serve` and `exec`, a server that would not start for another reason | the Run's code, `server_unavailable` |
  | `2` | invalid input; for `serve` and `exec`, a settings file the server would not start on, with its reason | `invalid_input` |
  | `3` | `serve` and `exec`: the model server named by `provider.baseUrl` did not answer at start (not running, or not at that address) | `provider_unavailable` |
  | `124` | timed out | |
  | `130` | interrupted | |
- The receipt names the model that ran (`model_id`, `reasoning_effort`) and carries the server's `result` as sent: text, `usage` in tokens, and `cost`, the US dollars the provider reported for the Run's model requests (OpenRouter does). A Run whose provider reported no cost (llama.cpp, Codex) has no `cost`; Arden never estimates one. The server README's "Cost" says what it covers.
- `--model` takes an id `arden models` lists. Any other is refused before a chat is made (exit 2), with the ids the server has.
- A prompt longer than one message takes (100,000 characters) is refused before the server is reached (exit 2).
- `--approval` sets how the Run handles approvals. `--no-wait-approval` declines what needs an approval instead of waiting.
- Ctrl-C and `--timeout` stop the wait. The Run goes on in the server.

## A local model (llama.cpp) or OpenRouter

A settings file with a `chat-completions` provider runs on any OpenAI Chat Completions server. A local `llama-server` needs no key; the server finds out it is llama.cpp and reads the model's id, window and thinking switch from it. Give it a window of at least 32,768 tokens (`apps/server-ts/README.md` says why).

```bash
llama-server -m model.gguf --ctx-size 32768 --jinja --port 8080 &
mkdir -p /tmp/arden-local/work
cat > /tmp/arden-local/settings.json <<'JSON'
{ "dataDirectory": "/tmp/arden-local/data", "workspace": "/tmp/arden-local/work",
  "provider": { "kind": "chat-completions", "baseUrl": "http://127.0.0.1:8080/v1" },
  "approvalMode": "allow", "memory": false, "automations": false, "skillRoots": [] }
JSON
arden exec --config /tmp/arden-local/settings.json --output json \
  'What does `uname -s` print on this machine? Run it and tell me.'
```

Checked on 2026-11-16 with llama.cpp b12359 and Gemma 4 E2B (Q8_0) on an Apple-silicon Mac, every tool offered (trimmed):

```json
{"type":"command_receipt","status":"completed","exit_code":0,"model_id":"/…/gemma-4-E2B-it-Q8_0.gguf",
 "result":{"text":"The output of running `uname -s` is: Darwin","usage":{"prompt":12942,"completion":298,"total":26128,"cache_read":12888,"cache_write":0},"steps":1}}
```

llama.cpp names a model by its file path unless `llama-server --alias <name>` gives it a name; `arden models` prints the id either way. OpenRouter needs its key variable and a model: `"provider": { "kind": "chat-completions", "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }, "model": "openai/gpt-6-luna"`.

What each failure says, checked on 2026-11-16 (llama.cpp b12359):

| Case | Exit | Message |
| --- | --- | --- |
| `llama-server` not running at start (`exec`, `serve`) | 3 | `provider_unavailable`: ``The model server at http://127.0.0.1:8080/v1 (`provider.baseUrl`) did not answer: cannot reach http://127.0.0.1:8080/props: fetch failed (connect ECONNREFUSED 127.0.0.1:8080)`` |
| `model` not on the llama.cpp server | 2 | `Model is not on the llama.cpp server: <id> (it lists: <ids>)` |
| `server: "generic"` without `contextLimit` | 2 | ``Invalid settings: a `chat-completions` provider on a generic server needs `model` and `contextLimit` `` |
| `apiKeyEnv` names an unset variable | 2 | ``Missing environment variable <NAME>, named by `provider.apiKeyEnv` `` |
| `baseUrl` over plain HTTP to another machine with `apiKeyEnv` (`http://192.168.1.20:8080/v1`) | 2 | ``Invalid settings: `provider.baseUrl` would send the key in clear text to 192.168.1.20: use HTTPS, or remove `apiKeyEnv` if the server needs no key`` |
| `baseUrl` with a query (`…/v1?api_key=…`) or a fragment | 2 | ``Invalid settings: `provider.baseUrl` must not contain a query: a request path is appended to it`` |
| prompt larger than the model's window | 1 | `context_length_exceeded`: `Your input exceeds this model's context window. …` |
| `llama-server` stopped after the start | 1 | `provider_unavailable`: `llama.cpp: cannot reach http://127.0.0.1:8080/v1/chat/completions: fetch failed (connect ECONNREFUSED 127.0.0.1:8080)` |
| `--model` the server does not list (`run`) | 2 | `This server has no model <id>. It lists: <ids>` |

## Layout

- `src/cli.ts` parses arguments.
- `src/run.ts` holds `run`, `wait` and `sessions`; `src/models.ts` holds `models`.
- `src/serve.ts` holds `serve` and `exec`. The command line does not contain the server: it starts the one named by `ARDEN_SERVER_ENTRY`, else the installed `@arden-hq/server`, else the one beside it in this repository. `exec` starts it with `@arden-hq/headless`'s `startConfiguredServer`, as the benchmark runner does.
- `src/main.ts` is the entry.
