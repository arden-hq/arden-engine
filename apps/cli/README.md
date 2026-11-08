# `@arden-hq/cli`

The `arden` command. It sends work to a running Arden server and prints the result. A chat started here also appears in the Arden app.

It builds on `@arden-hq/headless` for the API calls.

## Build and run

```bash
just build                          # from the repository root
node apps/cli/dist/main.js run "Summarize my open tasks"
```

The package is private. It has no release of its own. To test it, run `bun run --cwd apps/cli test`.

## Commands

| Command | What it does |
| --- | --- |
| `arden run [prompt]` | Send a prompt and wait for the answer. Piped stdin joins the prompt in a `<stdin>` block |
| `arden wait <run-id>` | Wait for a Run that is already going |
| `arden sessions` | List recent chats |

Run `arden --help` for every option.

## Rules

- The server address is `--url` or `ARDEN_URL`.
- `--output json` and `--output jsonl` print one `command_receipt`. Its `status` is `completed`, `submitted`, `failed`, `cancelled`, `interrupted` or `timed_out`.
- Exit codes: `0` completed or submitted, `1` failed or cancelled, `2` invalid input, `124` timed out, `130` interrupted.
- `--approval` sets how the Run handles approvals. `--no-wait-approval` declines what needs an approval instead of waiting.
- Ctrl-C and `--timeout` stop the wait. The Run goes on in the server.

## Layout

- `src/cli.ts` parses arguments.
- `src/run.ts` holds `run`, `wait` and `sessions`.
- `src/main.ts` is the entry.
