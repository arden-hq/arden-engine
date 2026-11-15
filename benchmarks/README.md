# Arden benchmarks

Developer CLI for the selected core: Terminal-Bench, SWE-bench Pro public,
cleaned LongMemEval, BrowseComp, and DeepResearch Bench. Internal tests cover
history import, tool execution, request limits, restart, and compaction.

Arden runs its real server, provider, tools, persistence, and headless HTTP API.
Coding follows the production Chat → code-worker path. The launcher waits for
child work and queued result delivery before collecting the final answer.

## Build once

Requires Bun 1.3.10, Node 24+, Python 3.10+, and Docker. Run from the repository root:

```bash
bun run build:libs
bun run build:server
python3 benchmarks/package.py .arden-tmp/bench/runtime.tar.gz
docker build -t arden-bench -f benchmarks/Dockerfile .arden-tmp/bench
cp benchmarks/profiles/research.json benchmarks/profiles/local-research.json
```

Edit the copied profile: choose the exact model, reasoning effort, context limit,
timeout, request cap, and tools. Credentials stay in the named environment
variable, never in JSON. The model is offered only the tools in `tools`
(see [What a trial changes](#what-a-trial-changes)), and they are declared up
front, as other harnesses present a benchmark's tools; set `"toolSearch": true`
to keep the app's deferred tools and tool search instead. `example.json` is the coding profile; `memory.json`
enables real Wiki ingestion and retrieval. Research uses provider-hosted
`web_search` and Arden `web_fetch`; the endpoint must support Responses and
hosted search. For a Codex account, set `provider: "codex"`,
`baseUrl: "https://chatgpt.com/backend-api/codex"`, and the exact live model ID
(for example `openai-codex/gpt-5.6-sol`). Set `apiKeyEnv` to an environment
variable containing the access token, and `accountIdEnv` to one containing the
account ID. The runner validates model availability, reasoning effort, and
context limit against the account's live catalog. It does not refresh tokens;
expired authentication requires a fresh token before a new attempt. Never copy
the authentication file or refresh token into an image or candidate workspace.
For llama.cpp, OpenRouter or another Chat Completions server, set
`provider: "chat-completions"`, its `baseUrl`, and optionally `server`
(`llama.cpp`, `openrouter` or `generic`) when detection should not decide; the
server README's `chat-completions` section says what each one reads.
`llama-cpp.json` and `openrouter.json` are the coding profile on each. A local
llama.cpp server has no key, so its profile names no `apiKeyEnv`; OpenRouter's
names `OPENROUTER_API_KEY`. A trial forwards only the variables the profile
names (`profile_env.py`). On llama.cpp `model` is the server's own id: the
GGUF path, or the name `llama-server --alias` gives it. Profiles are checked
with the server's own settings rules before a trial starts. This route has no
hosted `web_search`, so it suits the coding and memory profiles, not Research.

A llama.cpp server on this machine runs a trial without Docker, with `single`
(below, under Harbor) as the batch driver's container would. Checked on
2026-11-16 with llama.cpp b12359 and Gemma 4 E2B: a one-file task, 4 model
requests, 62 s, `answer.txt` holding `42`, the judge (`judge.mjs`) answering
on the same profile:

```bash
llama-server -m model.gguf --alias gemma --ctx-size 32768 --jinja --port 8080 &
cp benchmarks/profiles/llama-cpp.json benchmarks/profiles/local-llama.json   # model: "gemma"
python3 benchmarks/cli.py single --profile benchmarks/profiles/local-llama.json \
  --prompt-file prompt.txt --workspace /tmp/task --output /tmp/trial --id smoke --allow-model-calls
# /tmp/trial/observations/result.json: "status": "completed"
# /tmp/trial/observations/usage.json:  "modelRequests": 4, "promptTokens": 9732, "completionTokens": 882
```

In a container (`run`, Harbor) the host's `127.0.0.1` is the container's own:
the container reaches the host as `host.docker.internal`, as
`llama-cpp-docker.json` does. The server takes plain HTTP to another host only
from a provider that sends no key, so that profile names no `apiKeyEnv` (the
server README says why). `run` passes
`--add-host host.docker.internal:host-gateway` and `harbor-compose.yaml` adds
the same entry, because Docker Engine on Linux defines that name only then;
Docker Desktop defines it itself. Checked on 2026-11-16 with Docker Desktop
29.9.2 on macOS and llama.cpp b12359: one `single` trial in the `arden-bench`
image completed, 4 model requests, `answer.txt` holding `42`. On Docker Desktop
a `llama-server` on the default `127.0.0.1` is reachable from the container,
so leave `--host` alone. On Linux the container reaches the host at the
`docker0` bridge address, so `llama-server` must listen there:
`--host 172.17.0.1` (the bridge address; `ip addr show docker0`), or
`--host 0.0.0.0`, which also exposes it to the network (not checked here).

```bash
llama-server -m model.gguf --alias gemma --ctx-size 32768 --jinja --port 8080 &
cp benchmarks/profiles/llama-cpp-docker.json benchmarks/profiles/local-llama-docker.json   # model: "gemma"
python3 benchmarks/cli.py run --suite <suite> --data <data> --image arden-bench \
  --profile benchmarks/profiles/local-llama-docker.json --output <dir> --limit 1 --allow-model-calls
```

The package contains built runtime files, workspace manifests, and the lockfile.
It excludes the checkout, personal state, datasets, and credentials. Linux
installs its own dependencies. Build between edits; batch runs resolve the image
to its immutable ID so parallel source work cannot alter a running experiment.
Use a new package filename or directory when rebuilding.

## What a trial changes

A trial runs the real server, but a benchmark needs a few things fixed. The
runner (`candidate.mjs`) writes them into one settings file (`settings.json`,
saved with the result), starts the server as its own process with
`--config settings.json`, and drives it over HTTP, as any outside program
would. The server applies the settings before the first prompt
(`apps/server-ts/src/serve/settings.ts` lists every field). It also counts the
trial's model requests and tokens into `usage.json` and stops the trial at the
profile's `maxModelRequests`. The evidence is saved next to the result:

- **Tools.** Before the first prompt the server writes one permission rule per tool in
  the server's catalog: `allow` for the profile's `tools`, `never` for the rest.
  A profile may give `blockedTools` instead of `tools`: then every catalog tool
  is allowed except the listed `sources` (whole groups) and `tools` (names).
  Sub-agents are on, with the app's default limits, only when `spawn_agent` is
  offered.
  A sub-agent runs on the profile's model unless `extraModels` lists more and
  the main model picks one.
  A `never` rule keeps a tool out of what the model is offered. The rules are in
  `permission-rules.json`, the catalog in `tool-catalog.json`.
- **Tools that always ask.** A few tools take no rule because they always ask
  the owner on a card (in 0.1.4: `space_archive`, `drive_upload`,
  `drive_share_file`; the list is saved in `tools-without-rule.json`). They stay
  offered. A profile may not name one. If the model calls one, or asks for a
  connection, the runner declines the card and the model carries on; each
  declined card is in `declined-requests.json`.
- **Bookkeeping tools.** Tools outside the catalog (`set_chat_summary`,
  `claim_record`, `claim_check`, `claim_review`, `evidence_record`) are always
  offered.
- **Working folder.** A chat has no working folder. The runner allows changes
  inside the task folder with a path rule, and starts every prompt with one
  sentence that names the folder. The benchmark's prompt follows unchanged.
- **Memory.** `"memory": false` turns off Memory recall and related chats for
  the chat (child agents keep the default). `context-N.json` is the server's
  record of which context parts each run used.
- **Fixed defaults.** Shared Skills from the home folder are not read. Idle
  compaction is off; compaction happens only when the context fills.
  Automations are off, except Memory Capture while history is imported.
- **Approvals.** Runs use the `allow` approval mode, so a command with host or
  network access runs without a card. A command asks for the sandbox only when
  the model passes `access: "sandbox"`.
- **Arden's sandbox.** `"commandSandbox": false` in the profile starts the
  server with its command sandbox off: every command runs with host access,
  whatever the model asks for. Use it only where the trial already sits in a
  throwaway container, as WildClawBench's does. Harbor's Codex agent and
  WildClawBench's own Codex runner turn Codex's sandbox off the same way.
- **Still from the host.** The prompt lists the command-line tools installed on
  the machine that runs the trial, and its time zone. In a container this is
  the image; on a bare host it is your machine.
- **Time limit.** `timeoutMs` counts from the start of the runner and covers
  the whole trial: server start, setup (about three seconds for the rules),
  history import, and every prompt. At the limit the runner cancels the run and
  still writes the transcript and token counts. The driver allows one more
  minute for that, then kills it. A trial that hits the limit is recorded as
  an error; `run` goes on to the next trial.

## Research and memory

Download official data separately, outside the candidate workspace. Use the
cleaned LongMemEval S/M files, the original encrypted BrowseComp CSV, and
DeepResearch's `data/prompt_data/query.jsonl`. Pins and source repositories are
in [upstreams.json](upstreams.json).

```bash
python3 benchmarks/cli.py inspect --suite browsecomp --data /path/to/browsecomp.csv
python3 benchmarks/cli.py run --suite browsecomp --data /path/to/browsecomp.csv \
  --profile benchmarks/profiles/local-research.json --image arden-bench \
  --output benchmarks/results/browsecomp-smoke --limit 3 --repeats 1 --allow-model-calls
python3 benchmarks/cli.py report --output benchmarks/results/browsecomp-smoke
```

Change `--suite` to `longmemeval` or `deepresearch` and select the corresponding
data/profile. `--ids` selects explicit IDs. `--resume` skips recorded trials;
incomplete attempts get fresh state and retain their earlier evidence. Changed
dataset, profile, image, adapter, selection, or repeat count rejects resume.
Recorded execution errors remain in predictions and the denominator; rerun them
in a new experiment rather than silently replacing failures.

Every trial gets a disposable container and fresh `ARDEN_DIR`. Only its sanitized
job, profile, and trial artifacts are mounted. Raw gold/reference data stays on
the host. Only credential variables named by the profile are forwarded.
LongMemEval imports supplied user **and assistant** turns at their original dates,
then waits for Arden's real memory capture before asking the held-out question.
Memory capture costs count toward the same request limit as answering.

`--allow-model-calls` acknowledges paid execution. Request caps are not dollar
caps: token prices, output lengths, provider retries, and hosted searches affect
cost. Establish a provider spending limit before large runs.

## Terminal-Bench through Harbor

Install Harbor at the commit in `upstreams.json` into a separate environment:

```bash
uv venv .arden-tmp/bench/venv
uv pip install --python .arden-tmp/bench/venv/bin/python \
  'harbor @ git+https://github.com/harbor-framework/harbor@5c364a538e0af19eb58a53fdb895d7c0f974cef5'
```

Use an explicit registry dataset version and absolute artifact paths:

```bash
PYTHONPATH="$PWD" .arden-tmp/bench/venv/bin/harbor run \
  --dataset terminal-bench@2.0 --agent benchmarks.adapters.harbor:Arden \
  --agent-kwarg runtime_archive="$PWD/.arden-tmp/bench/runtime.tar.gz" \
  --agent-kwarg profile_path="$PWD/benchmarks/profiles/local-code.json" \
  --extra-docker-compose benchmarks/harbor-compose.yaml \
  --jobs-dir "$PWD/benchmarks/results/terminal-bench"
```

Copy/edit `example.json` as `local-code.json` first; export its credential variable
in the host shell before running Harbor. Harbor owns environments,
timeouts, reset, verifier execution, and scores. The adapter currently supports
Debian/Ubuntu task images with `apt-get` and glibc. The Compose overlay enables
nested Bubblewrap user/PID namespaces; it does not use privileged containers or
mount the Docker socket. Keep candidate and verifier filesystem access under
Harbor's control. Never mount your home or raw benchmark reference directory.

Each trial records the server's own answer on whether a sandboxed command can
run, in `arden/observations/command-sandbox.json` next to the trial logs.
Without Bubblewrap Arden refuses sandboxed commands, and the model runs them
with host access inside the task container.

Harbor counts the task's time limit, not the profile's. When Harbor stops a
trial, the adapter tells the runner to stop, waits up to 45 seconds for it to
write the transcript, token counts and patch, then copies the trial folder out.
A failed copy is logged and does not replace the run's own error. The runner's
database is deleted before the copy, because it holds the values given to MCP
servers and job logs get shared.

Under Harbor the runner keeps the container's own `HOME` (`single --keep-home`),
so commands see what the task set up there. Without the flag, `single` and `run`
give the runner an empty home.

For task images where setup cannot reach a package manager, export a
ready Linux runtime from the `arden-bench` image once and pass
`--agent-kwarg prebuilt=true` with it as `runtime_archive`. The archive
holds `/opt/arden` with its Linux dependencies and Node as
`/usr/local/bin/arden-bench-node`; the task image needs only `python3` and a
glibc at least as new as the image's (Debian bookworm):

```bash
docker run --rm --entrypoint sh arden-bench -c \
  'cp /usr/local/bin/node /usr/local/bin/arden-bench-node && tar -czf - /opt/arden /usr/local/bin/arden-bench-node' \
  > "$PWD/.arden-tmp/bench/runtime-linux.tar.gz"
```

Tasks that limit the agent's network must also allow the model's host, e.g.
`--allow-agent-host chatgpt.com` for the Codex route (present in current
Harbor; check `harbor run --help` on the pinned commit).

## WildClawBench through Harbor

The 60 tasks ship as a Harbor dataset (`internlm/WildClawBench-Harbor`) on the prebuilt
image `wildclawbench-ubuntu:v1.3` (workdir `/tmp_workspace`, public network). Install
Harbor as above, then:

```bash
hf download internlm/WildClawBench-Harbor --repo-type dataset --local-dir "$PWD/.arden-tmp/bench/wildclaw"
# Some of the dataset's shell scripts have Windows line endings and fail in the task
# image ("set: pipefail: invalid option name"); strip them once after the download:
grep -lr $'\r' --include='*.sh' .arden-tmp/bench/wildclaw | xargs perl -pi -e 's/\r$//'
# The image is not pulled by Harbor: take Images/wildclawbench-ubuntu_v1.3.tar from the
# original WildClawBench dataset and `docker load -i` it first.
cp benchmarks/profiles/wildclaw.json benchmarks/profiles/local-wildclaw.json   # set model
export OPENAI_API_KEY=...        # the profile's apiKeyEnv
export OPENROUTER_API_KEY=... JUDGE_MODEL=...   # judge-based graders (see below)

PYTHONPATH="$PWD" .arden-tmp/bench/venv/bin/harbor run \
  -p "$PWD/.arden-tmp/bench/wildclaw" --include-task-name '06_Safety_Alignment_task_5*' \
  --agent benchmarks.adapters.harbor:Arden \
  --agent-kwarg runtime_archive="$PWD/.arden-tmp/bench/runtime.tar.gz" \
  --agent-kwarg profile_path="$PWD/benchmarks/profiles/local-wildclaw.json" \
  --agent-kwarg transcript=openclaw \
  --extra-docker-compose benchmarks/harbor-compose.yaml \
  --n-concurrent 2 --jobs-dir "$PWD/benchmarks/results/wildclaw"
```

Before the first run, fix two upstream dataset problems (2026-10-25; they
break every harness, not only Arden):

- The task scripts have Windows line endings, so `run-warmup.sh` fails with
  "set: pipefail: invalid option name" and the trial ends in `HealthcheckError`:
  `grep -rlI $'\r' --include='*.sh' .arden-tmp/bench/wildclaw | xargs sed -i '' $'s/\r$//'`.
- The image sets `http_proxy` to the authors' private proxy; the tasks' `task.toml`
  blanks it, so nothing to do inside Harbor, but a hand `docker run` needs
  `-e http_proxy= -e https_proxy=`.

Anonymous Hugging Face downloads of the full set (3,381 files) are rate-limited;
log in (`huggingface-cli login`) or fetch tasks with `--include "<task>/*"`. Set
`JUDGE_MODEL=openai/gpt-5.4` to match the upstream leaderboard (the Harbor tasks
default to `openai/gpt-4o-mini`), pass `--yes` so Harbor does not stop to confirm
`BRAVE_API_KEY`, and export `OPENROUTER_API_KEY` for the judge.

Per-trial reward, tokens, dollars and seconds (prices in $ per million
`input`, `cached_input`, `output` tokens).
`reward_mean` is over graded trials only; `reward_mean_ungraded_as_zero`
counts a trial with no reward (an error or a timeout) as zero:

```bash
python3 benchmarks/cli.py harbor-report --jobs-dir benchmarks/results/wildclaw --prices prices.json
```

Check the `--include-task-name` / `--n-tasks` flags with `harbor run --help` at the pinned
commit; the task directory names are `<category>_task_<n>_<slug>`.

- `transcript=openclaw` converts `observations/session.json` into OpenClaw `chat.jsonl`
  (`adapters/openclaw_transcript.py`) and writes it to
  `/root/.openclaw/agents/main/sessions/chat.jsonl` in the container after the run,
  also after a failed or timed-out run when the runner wrote a transcript. Without it Terminal-Bench runs are unchanged. Safety graders
  only read assistant `text` and `tool_use` blocks (`name`, `input`); Arden tool names are
  kept (`exec_command` is recognised as a shell tool, command read from `cmd`).
- Use `linux/amd64` images on Apple silicon only with emulation; expect it to be slow.
  The adapter needs `apt-get` and glibc in the image (Ubuntu: yes). Images are large;
  check `df -h` before loading. Run at most 2 trials at once.
- Search: Arden's `web_search` is provider-hosted (OpenAI Responses route only) and
  `web_fetch` works from the sandbox. The benchmark's `BRAVE_API_KEY` is not used by
  Arden: `exec_command` passes only an allowlist of host variables (shell, proxy, XDG)
  into its child, so a skill that reads `BRAVE_API_KEY` finds nothing. A search backend
  that needs a key must be a profile `mcpServers` entry; the adapter forwards the host
  variables named in its `environment` map.
- Commands run with host access inside the task container unless the model asks
  for the sandbox; nothing stops for approval in a benchmark run.
- Judge graders: whether the Harbor `tests/grader.py` needs `JUDGE_MODEL` and
  `OPENROUTER_API_KEY` in the verifier environment was not verifiable without the
  dataset (upstream judge defaults to `openai/gpt-5.4` through OpenRouter); read a
  task's `tests/` after download and export what it reads.
- Known gaps: no browser (Arden's browser tools need the desktop app, absent
  in a headless run; OpenClaw has one), so browser-dependent tasks will score low; transcript-based
  graders see Arden's format, not OpenClaw's; the Warmup mock services run from each
  task's `run-warmup.sh` healthcheck, which the adapter does not touch.

## SWE-bench Pro public

Prepare one generation task using its **official instance image**, preferably
pinned by digest:

```bash
python3 benchmarks/swe_task.py --data /path/to/public.csv --id INSTANCE_ID \
  --image OFFICIAL_INSTANCE_IMAGE --output .arden-tmp/bench/swe-instance
```

Run the Harbor command above with `--path .arden-tmp/bench/swe-instance` instead
of `--dataset`, plus `--disable-verification --agent-kwarg patch=true
--agent-kwarg case_id=INSTANCE_ID`. The generated task only performs generation.
Use the official evaluator in a fresh environment for grading.

The adapter exports `agent/arden/prediction.json` as the native JSON array of
`instance_id`, `patch`, and `prefix`. Patch extraction includes untracked files
and compares against the original base even if the candidate commits changes.
It uses a separate Git index. Combine arrays for a larger official evaluation:

```bash
python swe_bench_pro_eval.py --raw_sample_path /path/to/public.csv \
  --patch_path /path/to/combined-patches.json --output_dir /path/to/scores \
  --scripts_dir /path/to/official/run_scripts --dockerhub_username NAMESPACE --use_local_docker
```

Run from the pinned official checkout with its dependencies, image namespace,
and other required flags configured according to its README.

## Grade saved answers

Install each official scorer's dependencies in its own Python environment and
check out its exact `upstreams.json` commit. Generation and grading are separate:

```bash
/path/to/scorer/python benchmarks/grade.py --suite longmemeval \
  --upstream /path/to/LongMemEval --data /path/to/longmemeval_s_cleaned.json \
  --predictions benchmarks/results/memory/predictions-0.jsonl \
  --output benchmarks/results/memory/grade-0 --judge gpt-4o --allow-judge-calls
```

The same command supports `browsecomp` and `deepresearch`. BrowseComp requires
`--judge`; DeepResearch uses the pinned upstream judge configuration and rejects
that override. Its RACE and FACT pipelines also require the upstream API/search
credentials. Run once per repeat; `cli.py regrade` can invoke an explicit scorer
command for every predictions file using the `{predictions}` placeholder.

BrowseComp's pinned scorer returns `correct: yes` but compares it with `yes`.
The bridge normalizes that label and records
`upstream-with-correct-label-parser-v1`; it is an explicitly corrected scorer,
not a byte-for-byte official run. Question formatting, grading prompt, and
aggregation remain upstream-owned. Other suites use their native scorers.

For BrowseComp grading through Arden's own provider (any profile kind: Codex,
Responses, Chat Completions), add `--provider-profile` with the same
profile file and set `--judge` to its exact model ID. This uses Arden's provider
transport with the upstream grading prompt, empty system instructions, and the
profile's reasoning setting. It does not apply upstream temperature/max-token
settings. Judge responses and token usage are saved separately. Using the same
model for candidate and judge is useful for a smoke run; calibrate the judge
before treating larger scores as comparative evidence.

## Evidence and verification

Artifacts include effective profile/tool configuration, native session archives,
all run details and durable events (including children and ingestion), memory
capture status, usage, errors, immutable image ID, and input hashes. Results are
private local files. `report` describes execution and token usage; completion
is not benchmark correctness, and there is no blended five-suite score.

```bash
python3 -m unittest discover -s benchmarks/tests -p 'test_*.py'
node --test benchmarks/tests/candidate.test.mjs benchmarks/tests/history.test.mjs benchmarks/tests/profile.test.mjs
```

Build first (`bun run build:libs && bun run build:server`); the runner imports
the built server. These tests use a local fake provider. They verify plumbing:
tool rules, a sandboxed command in the task folder, a declined card, the memory
switch, the request limit, restart, and compaction. They do not measure model
quality or memory accuracy.

Checked on 2026-11-10 with a fake provider, on arm64: the Docker image builds,
`node-pty` compiles and opens a terminal in it, Bubblewrap runs, the Node tests
above pass inside it, and the Harbor adapter completes Harbor's `hello-world`
task end to end (install, sandboxed command, logs, token counts, reward 1).

One WildClawBench task (`06_Safety_Alignment_task_5`) was also run that day on
the upstream amd64 image with a Codex account model: the grader read the
transcript and scored 0.8.

Not verified yet: native x86_64, the other 59 WildClawBench tasks, and the
judge-based graders. Full-suite results and judge calibration are pending.
