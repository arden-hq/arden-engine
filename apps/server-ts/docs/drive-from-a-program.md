# Drive the server from a program

Reference for a benchmark adapter, a CI job or any program that starts a server from a settings file and owns it. The short version is in the [server README](../README.md).

## Settings file

Only `dataDirectory` is required, and it may not be `~/.arden`. `src/serve/settings.ts` lists every field with its meaning: provider and models, step and request limits, tools, sub-agents, approval mode, whether a person follows the chats (`userFacing`), compaction, Memory, Automations, MCP servers, Skills, the command sandbox. A key is never in the file; the file names the environment variable that holds it. A mistake exits with code 2 and one line that names the field. A model server that does not answer at `provider.baseUrl` exits with code 3 and one line that names the address and the cause: the file may be right and the model server not running. The codes are `CONFIGURED_SERVER_EXIT` in `@arden-hq/protocol/daemon`.

## Ready line

When every setting is in place the server prints one JSON line on stdout (`ConfiguredServerReady` in `@arden-hq/protocol/daemon`): `type: "ready"`, `url`, `dataDirectory`, `accessFile`, `usageFile`, `offeredTools` (absent when every tool is offered), `toolsWithoutRule`, `mcpServers`, and what a new chat runs on: `provider` (the model list's provider id), `model` and `contextWindow` (after `contextLimit`). Nothing else goes to stdout; the log goes to stderr.

## Access

`accessFile` (`cli-access.json` in the data folder) holds the server URL and a secret. Send the secret as the `x-arden-local-capability` header. It is the owner's secret: whoever started the server reaches every route. `arden run`, `arden wait` and `arden sessions` find it on their own for the default folder; for another one, set `ARDEN_DIR=<dataDirectory>`.

## Turns

`POST /chat/message` starts a Run and returns its id at once; `GET /chat/runs/:id` and the event stream say when it ended and carry text, usage and steps. A message sent while a Run is going joins it and the receipt says `delivery: "steered"`. A message that must wait for the Run to end goes to `POST /sessions/:id/queue`. `POST /cancel` interrupts. `GET /chat/runs` lists every Run, sub-agent Runs included, and says whether the server is `idle`. `@arden-hq/headless` wraps all of these.

## Usage

`usageFile` holds the model requests and tokens of the whole data folder, sub-agents and side jobs included, rewritten after every request. Past `maxModelRequests` the next request fails and the file says `budgetExhausted`.

## Stop

SIGINT or SIGTERM stops the server cleanly and removes the access file. A later start on the same data folder applies the settings file again and goes on counting usage.

## One prompt

`arden exec --config settings.json "prompt"` does all of it: start, one Run, a JSON receipt, stop.
