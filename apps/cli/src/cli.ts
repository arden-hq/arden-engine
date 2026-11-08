import {
  CLI_APPROVAL_MODES,
  CLI_DEFAULT_APPROVAL_MODE,
  isCliApprovalMode,
  type CliApprovalMode
} from "@arden-hq/protocol/permissions"

import { timeoutMilliseconds, UsageError, valueAfter, type CliDependencies } from "./command.js"
import {
  invalidInputReceipt,
  runCommand,
  sessionsCommand,
  waitCommand,
  type ApprovalHandling,
  type CliOutputFormat,
  type RunOptions,
  type SessionsOptions,
  type SessionTarget,
  type WaitOptions
} from "./run.js"
import { errorMessage } from "@arden-hq/std/errors"

export type {
  CliOutputFormat,
  CommandReceiptError,
  CommandReceiptV1,
  DeclinedRequest
} from "./run.js"

type ParsedCommand =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly options: RunOptions }
  | { readonly kind: "wait"; readonly options: WaitOptions }
  | { readonly kind: "sessions"; readonly options: SessionsOptions }

const HELP = `Usage:
  arden run [prompt] [options]
  arden wait <run-id> [options]
  arden sessions [options]

Talks to the running Arden app (or --url / ARDEN_URL). Chats started here
appear in Arden like any other.

Run options:
  --session <id>          Send to this chat
  --continue              Send to the most recently active chat
  --fork <id>             Send to a copy of this chat; the original stays as it was
  --space <name|id>        Start the new chat in this Space
  --model <id>            Start the new chat on this model
  --recipe <name>         Start from this Recipe (Skill)
  --image <path>          Attach a .png or .jpg image (repeatable)
  --output-schema <file>  A JSON Schema the final answer must match; json
                          output carries the parsed answer as result.data
  --approval <mode>       ${CLI_APPROVAL_MODES.join(" or ")} (default: ${CLI_DEFAULT_APPROVAL_MODE});
                          Auto and Never ask are set in the app
  --no-wait-approval      Decline what needs approval instead of waiting for
                          someone to answer it in Arden
  --detach                Print the run id and exit; the Run goes on in Arden
  --output <format>       text, json, or jsonl (default: text)
  --timeout <seconds>     Cancel the Run if it takes longer
  --url <url>             Arden server URL (or ARDEN_URL)

  A prompt argument plus piped stdin sends both: stdin follows in a <stdin> block.

Wait options:
  --no-wait-approval, --output, --timeout, --url as above. Ctrl-C and
  --timeout stop waiting; the Run goes on.

Sessions options:
  --limit <n>             How many chats (default: 20)
  --output <format>       text or json (default: text)
  --url <url>             Arden server URL (or ARDEN_URL)

Exit status:
  0 completed (or submitted with --detach)   1 failed or cancelled
  2 invalid input   124 timed out   130 interrupted
  json/jsonl print one command_receipt; its status is completed, submitted,
  failed, cancelled, interrupted, or timed_out.`

const outputFormat = (value: string): CliOutputFormat => {
  if (value === "text" || value === "json" || value === "jsonl") return value
  throw new UsageError("--output must be text, json, or jsonl")
}

const approvalMode = (value: string): CliApprovalMode => {
  if (isCliApprovalMode(value)) return value
  throw new UsageError(`--approval must be ${CLI_APPROVAL_MODES.join(" or ")}`)
}

const positiveCount = (value: string, name: string): number => {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new UsageError(`${name} must be a positive integer`)
  }
  return count
}

const FLAGS: ReadonlySet<string> = new Set(["--continue", "--detach", "--no-wait-approval"])

interface ParsedArgs {
  readonly positionals: ReadonlyArray<string>
  readonly flags: ReadonlySet<string>
  readonly values: ReadonlyMap<string, ReadonlyArray<string>>
}

const splitArgs = (
  args: ReadonlyArray<string>,
  allowed: ReadonlySet<string>
): ParsedArgs | undefined => {
  const positionals: Array<string> = []
  const flags = new Set<string>()
  const values = new Map<string, Array<string>>()
  for (let index = 0; ; index += 1) {
    const argument = args[index]
    if (argument === undefined) break
    if (argument === "-h" || argument === "--help") return undefined
    if (argument === "--") {
      positionals.push(...args.slice(index + 1))
      break
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument)
      continue
    }
    const equals = argument.indexOf("=")
    const name = equals === -1 ? argument : argument.slice(0, equals)
    if (!allowed.has(name)) throw new UsageError(`Unknown option: ${name}`)
    if (FLAGS.has(name)) {
      if (equals !== -1) throw new UsageError(`${name} takes no value`)
      flags.add(name)
      continue
    }
    const parsed = valueAfter(
      args,
      index,
      name,
      equals === -1 ? undefined : argument.slice(equals + 1)
    )
    index = parsed.nextIndex
    values.set(name, [...(values.get(name) ?? []), parsed.value])
  }
  return { positionals, flags, values }
}

const single = (parsed: ParsedArgs, name: string): string | undefined => {
  const given = parsed.values.get(name)
  if (given === undefined) return undefined
  if (given.length > 1) throw new UsageError(`${name} is given more than once`)
  return given[0]
}

const RUN_OPTIONS: ReadonlySet<string> = new Set([
  "--url",
  "--session",
  "--continue",
  "--fork",
  "--space",
  "--model",
  "--recipe",
  "--image",
  "--output-schema",
  "--approval",
  "--no-wait-approval",
  "--detach",
  "--output",
  "--timeout"
])

const sessionTarget = (parsed: ParsedArgs): SessionTarget => {
  const sessionId = single(parsed, "--session")
  const forkId = single(parsed, "--fork")
  const latest = parsed.flags.has("--continue")
  const chosen = [sessionId !== undefined, forkId !== undefined, latest].filter(Boolean).length
  if (chosen > 1) throw new UsageError("Use only one of --session, --continue, and --fork")
  const space = single(parsed, "--space")
  const model = single(parsed, "--model")
  if (chosen === 1 && (space !== undefined || model !== undefined)) {
    throw new UsageError(
      "--space and --model start a new chat; drop --session, --continue, or --fork"
    )
  }
  if (sessionId !== undefined) return { kind: "existing", sessionId }
  if (forkId !== undefined) return { kind: "fork", sessionId: forkId }
  if (latest) return { kind: "latest" }
  return { kind: "new", space, model }
}

const approvalHandling = (parsed: ParsedArgs): ApprovalHandling =>
  parsed.flags.has("--no-wait-approval") ? "decline" : "wait"

const parseRun = (args: ReadonlyArray<string>): ParsedCommand => {
  const parsed = splitArgs(args, RUN_OPTIONS)
  if (parsed === undefined) return { kind: "help" }
  const output = outputFormat(single(parsed, "--output") ?? "text")
  const timeout = single(parsed, "--timeout")
  const mode = single(parsed, "--approval")
  const detach = parsed.flags.has("--detach")
  if (detach && timeout !== undefined) {
    throw new UsageError("--detach does not wait, so it takes no --timeout")
  }
  if (detach && parsed.flags.has("--no-wait-approval")) {
    throw new UsageError("--detach leaves approvals to Arden; drop --no-wait-approval")
  }
  return {
    kind: "run",
    options: {
      promptArgument: parsed.positionals.length === 0 ? undefined : parsed.positionals.join(" "),
      urlArgument: single(parsed, "--url"),
      target: sessionTarget(parsed),
      recipe: single(parsed, "--recipe"),
      imagePaths: parsed.values.get("--image") ?? [],
      outputSchemaPath: single(parsed, "--output-schema"),
      approvalMode: mode === undefined ? undefined : approvalMode(mode),
      approvals: approvalHandling(parsed),
      output,
      timeoutMs: timeout === undefined ? undefined : timeoutMilliseconds(timeout),
      detach
    }
  }
}

const WAIT_OPTIONS: ReadonlySet<string> = new Set([
  "--url",
  "--no-wait-approval",
  "--output",
  "--timeout"
])

const parseWait = (args: ReadonlyArray<string>): ParsedCommand => {
  const parsed = splitArgs(args, WAIT_OPTIONS)
  if (parsed === undefined) return { kind: "help" }
  const [runId, ...extra] = parsed.positionals
  if (runId === undefined) throw new UsageError("wait requires a run id")
  if (extra.length > 0) throw new UsageError(`Unexpected argument: ${extra[0]}`)
  const timeout = single(parsed, "--timeout")
  return {
    kind: "wait",
    options: {
      runId,
      urlArgument: single(parsed, "--url"),
      approvals: approvalHandling(parsed),
      output: outputFormat(single(parsed, "--output") ?? "text"),
      timeoutMs: timeout === undefined ? undefined : timeoutMilliseconds(timeout)
    }
  }
}

const SESSIONS_OPTIONS: ReadonlySet<string> = new Set(["--url", "--limit", "--output"])

const parseSessions = (args: ReadonlyArray<string>): ParsedCommand => {
  const parsed = splitArgs(args, SESSIONS_OPTIONS)
  if (parsed === undefined) return { kind: "help" }
  const [extra] = parsed.positionals
  if (extra !== undefined) throw new UsageError(`Unexpected argument: ${extra}`)
  const output = single(parsed, "--output") ?? "text"
  if (output !== "text" && output !== "json") throw new UsageError("--output must be text or json")
  const limit = single(parsed, "--limit")
  return {
    kind: "sessions",
    options: {
      urlArgument: single(parsed, "--url"),
      limit: limit === undefined ? 20 : positiveCount(limit, "--limit"),
      output
    }
  }
}

const parseArgs = (args: ReadonlyArray<string>): ParsedCommand => {
  const [command, ...rest] = args
  switch (command) {
    case undefined:
    case "-h":
    case "--help":
      return { kind: "help" }
    case "run":
      return parseRun(rest)
    case "wait":
      return parseWait(rest)
    case "sessions":
      return parseSessions(rest)
    default:
      throw new UsageError(`Unknown command: ${command}`)
  }
}

const machineOutputFromArgs = (
  args: ReadonlyArray<string>
): { readonly command: "run" | "wait"; readonly output: "json" | "jsonl" } | undefined => {
  const command = args[0]
  if (command !== "run" && command !== "wait") return undefined
  let output: string | undefined
  for (let index = 1; ; index += 1) {
    const argument = args[index]
    if (argument === undefined || argument === "--") break
    if (argument === "--output") output = args[index + 1]
    else if (argument.startsWith("--output=")) output = argument.slice("--output=".length)
  }
  return output === "json" || output === "jsonl" ? { command, output } : undefined
}

export const runCli = async (
  args: ReadonlyArray<string>,
  dependencies: CliDependencies
): Promise<number> => {
  let command: ParsedCommand
  try {
    command = parseArgs(args)
  } catch (cause) {
    const machine = machineOutputFromArgs(args)
    if (machine !== undefined) {
      const receipt = invalidInputReceipt(machine.command, errorMessage(cause))
      dependencies.writeStdout(`${JSON.stringify(receipt)}\n`)
      return 2
    }
    dependencies.writeStderr(`arden: ${errorMessage(cause)}\nTry 'arden --help'.\n`)
    return 2
  }
  switch (command.kind) {
    case "help":
      dependencies.writeStdout(HELP)
      return 0
    case "run":
      return runCommand(command.options, dependencies)
    case "wait":
      return waitCommand(command.options, dependencies)
    case "sessions":
      return sessionsCommand(command.options, dependencies)
  }
}
