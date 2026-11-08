import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { commandTarget } from "./action-targets.js"
import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { PermissionRules } from "../persistence/permissions/rules.js"
import { COMMAND_TOOL } from "../persistence/permissions/command-policy.js"
import {
  matchesHostCommands,
  isSystemJobRun,
  readRunRules,
  ruleDecision,
  type RunRules
} from "../execution/rules.js"
import type { RunAuthority } from "../execution/authority.js"
import { ConversationArtifacts } from "../artifacts/conversation.js"
import { sessionLineage } from "../persistence/sessions/lineage.js"
import { changesNothing, isReadOnlyCommand } from "./bash-safe-commands.js"
import { parseCommandSegments } from "./bash-permissions.js"
import { refuseNeverPaths } from "./command-paths.js"
import {
  approvalPrompt,
  commandGrantPlan,
  commandSkipsCard,
  hostCommandNeed,
  approvalRule,
  networkReach,
  type ResolvedShell,
  ShellAccessSchema,
  shellRuntime,
  type ShellRuntime,
  type ShellRuntimeOptions,
  type TypedInto,
  workingDirectory
} from "./shell-policy.js"
import {
  EMPTY_LINE,
  INTERRUPT,
  typedCommands,
  typedInputJudged,
  typedInputRefused,
  typeInto,
  type TypedCommands,
  type TypedLine
} from "./typed-input.js"
import { sessionPathPolicy } from "../storage/local-paths.js"
import type { HostCommandGrantPlan } from "./bash-permissions.js"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { ardenDataRoots, mentionsArdenData } from "./arden-data-mention.js"
import { DataRoot } from "../runtime/data-root.js"
import { resolveCommandSandbox } from "../runtime/command-sandbox.js"
import {
  CommandInterrupted,
  type CommandExited,
  MAX_CAPTURE_BYTES,
  runCommandUntil
} from "./shell-run.js"
import type { LocalPathServices } from "../storage/local-paths.js"
import { TerminalSessions } from "../terminals/service.js"
import type { TerminalInfo, TerminalStore } from "../terminals/store.js"
import { spawnLiveProcess, type ProcessExit } from "../terminals/live-process.js"
import type { ServerRunContext } from "./run-context.js"
import { sharedResourceSessions } from "../execution/authority.js"
import { refusalPath } from "../execution/decide.js"
import { refusalError } from "./refusal.js"
import type { ToolContext } from "@arden-hq/loop"
import { toolRefusal } from "./tool-failure.js"

const DEFAULT_YIELD_MS = 10_000
const MAX_EXEC_YIELD_MS = 30_000
const DEFAULT_WRITE_YIELD_MS = 1_000
const MIN_POLL_YIELD_MS = 5_000
const MAX_YIELD_INPUT_MS = 300_000
const MIN_YIELD_MS = 250

const yieldTime = (description: string) =>
  Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(MIN_YIELD_MS),
      Schema.isLessThanOrEqualTo(MAX_YIELD_INPUT_MS)
    ).annotate({ description })
  )

const ExecParametersSchema = Schema.Struct({
  cmd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
    description:
      "Bash source passed to /bin/bash -c (1-20,000 characters). Each call starts a fresh process: quote paths and include all shell state the command needs."
  }),
  workdir: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
      description:
        "Directory to run in. Defaults to the current Local folder, must be inside allowed roots, and is required when no Local folder is set."
    })
  ),
  access: Schema.optionalKey(
    ShellAccessSchema.annotate({
      description:
        'Where the command runs. "sandbox" (the code-agent default): reads everything except secret folders, writes only the Local folder and temp, no network. "network": the same sandbox plus connections to other machines (not localhost or local sockets), for downloads, package installs, git over https and remote APIs; it follows the approval mode. "host" (the ordinary-Chat default): no sandbox, as the user would, behind approval; use it for ssh, saved logins or keys, and changes outside the Local folder.'
    })
  ),
  tty: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Run the command in a terminal with its input open, so write_stdin can answer its prompts and interactive tools behave as they would for a person. Defaults to false: input is closed, and a command that asks a question reads an empty answer."
    })
  ),
  yield_time_ms: yieldTime(
    "How long to wait for the command to finish before returning its session ID (250-30,000; default 10,000). The command keeps running after that."
  )
})

const WriteParametersSchema = Schema.Struct({
  session_id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The session ID exec_command returned for a command that was still running."
  }),
  chars: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(8_000)).annotate({
      description:
        'Characters to type, such as "y\\n". "\\u0003" sends Ctrl-C. Empty or omitted only reads new output.'
    })
  ),
  yield_time_ms: yieldTime(
    "How long to wait for output. Defaults to 1,000 after typing and 5,000 for a read; waits at most 30,000, and a read at least 5,000. Returns early when the process ends."
  )
})

interface ShellToolServices extends LocalPathServices {
  readonly rules: PermissionRules["Service"]
  readonly artifacts?: ConversationArtifacts["Service"]
  readonly terminals: TerminalStore
}

const makeExecCommandTool = (
  services: ShellToolServices,
  options: ShellRuntimeOptions = {}
): ServerTool => {
  const runtime = async (): Promise<ShellRuntime> =>
    shellRuntime({ commandSandbox: await resolveCommandSandbox(), ...options })
  const tool: ServerTool = defineServerTool({
    name: COMMAND_TOOL,
    description: [
      "Run one Bash command in a fresh local process.",
      "If it finishes within yield_time_ms you get its output and exit code. If it is still running (a dev server, a watcher, a long build, a prompt), you get the output so far and a session ID; the process keeps running and you can read it, type into it, or stop it with write_stdin.",
      "No shell state persists between calls. Prefer file_read, file_list, file_find, file_search_text, file_write, and file_edit for ordinary file work.",
      "Ordinary Chats default to host access; code agents default to their own folder's sandbox. A sandboxed command needs a workdir inside a folder a rule lets Arden change.",
      "The sandbox reads the whole machine except secret folders (ssh and gpg keys, cloud logins, keychains, browser profiles, Arden's data), so installed CLIs, virtualenvs and toolchains run; it writes only its Local folder and temporary directories, has no network, and may list processes but signal only ones it started.",
      "When a command needs more, run it again with the narrowest escalation instead of working around the sandbox: access=network when it only needs the network (a download, a package install, git over https, an API); access=host when it needs ssh, the user's saved logins or keys, Git config or a new repository (git init, clone, worktree add, remote add, git config; on macOS add, commit, branch, checkout and stash work in the sandbox), or changes outside the Local folder. Both follow the approval mode.",
      `Approved network access reaches ${networkReach()}.`,
      "Host access runs with no sandbox, with the user's HOME and PATH but without credential environment variables, and follows the chat's approval mode (the user may require their own approval for every host command). In a run no one is watching (an Automation, a Task's job, an agent a chat started), a host command that needs approval does not run then: its card waits for the user in this run's chat, and approving it runs the command. Skip it, finish the rest, and say in your report that it waits on the user's approval.",
      "Cancellation after the process starts can leave side effects with unknown outcome, so inspect state before retrying."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ExecParametersSchema),
    metadata: {
      display: { card: "command", refresh: "terminals" },
      effect: "local_files",
      detached: true,
      read_only_mode: "self_gated",
      local_target: { arg: "workdir", kind: "directory" },
      display_name: "Command",
      kind: "shell",
      action: "execute",
      approval_preview: "Run a local shell command.",
      source: "_shell",
      changes_state: true,
      target: "reported",
      concurrency_group: "filesystem",
      destructive: true,
      default_approval: "approve",
      open_world: true,
      idempotent: false
    },
    shellCommand: async (input, ctx) => ({
      command: input.cmd,
      cwd: (await workingDirectory(services, input, ctx)).cwd
    }),
    approvalRequirement: async (input, ctx) => {
      const resolved = await workingDirectory(services, input, ctx)
      await refuseNeverPaths(input.cmd, resolved.cwd, resolved.policy)
      return commandCard(services, {
        command: input.cmd,
        resolved,
        mode: ctx.run.approvalMode,
        authority: ctx.run.authority,
        plan: async (rules) => commandGrantPlan(rules, input.cmd, resolved, await runtime())
      })
    },
    approvalPrompt: async (input, ctx) => {
      const resolved = await workingDirectory(services, input, ctx)
      return approvalPrompt({
        command: input.cmd,
        resolved,
        ardenData: namesArdenData(services, input.cmd, resolved)
      })
    },
    execute: async (input, ctx, effects) => {
      const { cwd, policy, access } = await workingDirectory(services, input, ctx)
      await refuseNeverPaths(input.cmd, cwd, policy)
      const shell = await runtime()
      const approvedCwd = ctx.approval?.data?.working_directory
      const approvedAccess = ctx.approval?.data?.access
      if (ctx.approval !== undefined && (approvedCwd !== cwd || approvedAccess !== access)) {
        throw toolRefusal(
          "The shell access changed after this command was approved. Request approval again.",
          "Shell access changed"
        )
      }
      const preserveOutput = async (
        bytes: Buffer,
        truncated: boolean
      ): Promise<string | undefined> => {
        if (services.artifacts === undefined || bytes.length === 0) return undefined
        const lineage = await Effect.runPromise(
          sessionLineage(services.sessions, ctx.run.sessionId)
        )
        const ownerSessionId = lineage.at(-1)?.sessionId
        if (ownerSessionId === undefined)
          throw toolRefusal("The command output owner could not be resolved.", "Output unavailable")
        const manifest = await Effect.runPromise(
          services.artifacts.createFile({
            sessionId: ownerSessionId,
            producerRunId: ctx.run.runId,
            operationKey: `exec_command:${ctx.toolCallId}:output`,
            source: { kind: "bytes", bytes, filename: "command-output.txt" },
            title: "Command output",
            summary: `${truncated ? "Output head and tail" : "Full output"} for command call ${ctx.toolCallId}`,
            mediaType: "text/plain",
            role: "working"
          })
        )
        return manifest.ref
      }
      const readsOnly = changesNothing(input.cmd, cwd)
      if (readsOnly) effects.unchanged()
      else
        await effects.target(
          commandTarget({
            toolCallId: ctx.toolCallId,
            command: input.cmd,
            cwd,
            home: shell.homeDirectory
          })
        )
      let terminalId: number | undefined
      let outcome: Awaited<ReturnType<typeof runCommandUntil>>
      try {
        outcome = await runCommandUntil(input.cmd, cwd, ctx.signal, policy, {
          ...shell,
          yieldMs: Math.min(input.yield_time_ms ?? DEFAULT_YIELD_MS, MAX_EXEC_YIELD_MS),
          input: input.tty === true ? "pipe" : "closed",
          captureFullOutput: services.artifacts !== undefined,
          spawn: (invocation, mode) => {
            const process = spawnLiveProcess(invocation, { input: mode })
            if (!readsOnly) effects.sent()
            terminalId = services.terminals.start({
              sessionId: ctx.run.sessionId,
              runId: ctx.run.runId,
              toolCallId: ctx.toolCallId,
              command: input.cmd,
              cwd,
              access,
              approvalMode: ctx.run.approvalMode,
              process
            }).id
            return process
          },
          onOutput: (frame) =>
            ctx.run.emitToolOutput({
              toolCallId: ctx.toolCallId,
              stream: frame.stream,
              delta: frame.delta
            })
        })
      } catch (cause) {
        if (terminalId !== undefined) services.terminals.release(terminalId)
        if (!(cause instanceof CommandInterrupted)) throw cause
        const artifactRef = await preserveOutput(cause.output, cause.outputTruncated)
        const reference =
          artifactRef === undefined
            ? ""
            : ` Output: artifact_ref ${artifactRef}${cause.outputTruncated ? " (head and tail; middle omitted)" : ""}.`
        if (artifactRef !== undefined)
          await ctx.run.emitToolProgress({
            toolCallId: ctx.toolCallId,
            message: `Command output saved as artifact_ref ${artifactRef}`,
            data: { artifact_ref: artifactRef, truncated: cause.outputTruncated }
          })
        throw new ToolExecutionError(`${cause.message}${reference}`, {
          preview: "Command interrupted",
          retryable: false
        })
      }
      if (outcome.state === "running") {
        if (terminalId === undefined) throw new Error("A running command has no terminal.")
        services.terminals.detach(terminalId)
        return {
          result: [
            `Process running with session ID ${terminalId}.`,
            `Use write_stdin with session_id ${terminalId} to read new output, type input, or send "\\u0003" to stop it.`,
            ...(outcome.output.length === 0 ? [] : ["Output so far:", outcome.output])
          ].join("\n"),
          preview: "Still running",
          data: { cwd, access, session_id: terminalId, state: "running" }
        }
      }
      if (terminalId !== undefined) services.terminals.release(terminalId)
      if (!readsOnly) {
        if (outcome.exitCode === 0) effects.applied()
        else effects.failed()
      }
      return exitedResult(outcome, { cwd, access, preserveOutput, ctx })
    }
  })
  return tool
}

const exitedResult = async (
  outcome: CommandExited,
  {
    cwd,
    access,
    preserveOutput,
    ctx
  }: {
    readonly cwd: string
    readonly access: string
    readonly preserveOutput: (bytes: Buffer, truncated: boolean) => Promise<string | undefined>
    readonly ctx: ToolContext<ServerRunContext>
  }
) => {
  const artifactRef =
    outcome.fullOutput !== undefined &&
    (outcome.fullOutput.length > MAX_CAPTURE_BYTES || outcome.exitCode !== 0)
      ? await preserveOutput(outcome.fullOutput, outcome.fullOutputTruncated)
      : undefined
  const artifactNote =
    artifactRef === undefined
      ? ""
      : `\n\n${outcome.fullOutputTruncated ? "Output head and tail (middle omitted)" : "Full output"}: artifact_ref ${artifactRef}. Use artifact_export to inspect it.`
  if (outcome.exitCode !== 0) {
    throw toolRefusal(`${outcome.output}${artifactNote}`, `Exit ${outcome.exitCode}`)
  }
  const lines = outcome.output.split("\n").length
  return {
    result: `${outcome.output}${artifactNote}`,
    preview: `${countOf(lines, "output line")}`,
    data: {
      cwd,
      access,
      state: "exited",
      ...(ctx.approval?.grantStanding === true && approvalRule(ctx.approval.data) !== undefined
        ? { approval_rule: approvalRule(ctx.approval.data) }
        : {}),
      exit_code: outcome.exitCode,
      stdout_bytes: outcome.stdoutBytes,
      stderr_bytes: outcome.stderrBytes,
      ...(artifactRef === undefined ? {} : { artifact_ref: artifactRef }),
      output_artifact_truncated: outcome.fullOutputTruncated
    }
  }
}

const makeWriteStdinTool = (services: ShellToolServices): ServerTool => {
  const pendingLines = new Map<number, { readonly toolCallId: string; readonly line: TypedLine }>()
  services.terminals.subscribe((event) => {
    if (event.type === "removed" || event.terminal.exit !== undefined)
      pendingLines.delete(event.terminal.id)
  })
  const typed = (terminal: TerminalInfo, chars: string) => {
    const held = pendingLines.get(terminal.id)
    const input = typeInto(held?.toolCallId === terminal.toolCallId ? held.line : EMPTY_LINE, chars)
    if (input.kind === "refused")
      throw toolRefusal(
        "The input holds a NUL character, which cannot be checked, so nothing was typed.",
        "Input refused"
      )
    return { pending: input.pending, commands: typedCommands(input.sent) }
  }
  return defineServerTool({
    name: "write_stdin",
    description: [
      "Type into, read, or stop a command that exec_command left running, by its session ID.",
      "Returns the output since your last read and whether the process is still running.",
      'Send "\\u0003" to stop it with Ctrl-C. Typing needs the command to have been started with tty=true.',
      "Only commands started in this Chat or a granted shared Session are reachable."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(WriteParametersSchema),
    metadata: {
      effect: "local_files",
      detached: true,
      read_only_mode: "self_gated",
      display_name: "Command input",
      kind: "shell",
      action: "execute",
      approval_preview: "Type into a running command.",
      source: "_shell",
      changes_state: false,
      concurrency_group: "terminal",
      destructive: false,
      default_approval: "approve",
      refuse_unattended: true,
      open_world: true,
      idempotent: false
    },
    shellCommand: async (input, ctx) => {
      const terminal = reachableTerminal(services.terminals, input.session_id, ctx.run)
      if (terminal === undefined) return undefined
      const { commands } = typed(terminal, input.chars ?? "")
      return commands.kind === "lines" && commands.judged !== undefined
        ? { command: commands.judged, cwd: terminal.cwd }
        : undefined
    },
    approvalRequirement: async (input, ctx) => {
      const terminal = reachableTerminal(services.terminals, input.session_id, ctx.run)
      if (terminal === undefined || ctx.run.approvalMode === "read_only") return undefined
      const judged = typedInputJudged({
        access: terminal.access,
        launchMode: terminal.approvalMode,
        mode: ctx.run.approvalMode
      })
      if (!judged) return undefined
      const chars = input.chars ?? ""
      const { commands } = typed(terminal, chars)
      if (commands.kind !== "lines") return undefined
      const card = await commandCard(services, {
        command: commands.judged ?? "",
        resolved: await terminalShell(services, terminal, ctx),
        mode: ctx.run.approvalMode,
        authority: ctx.run.authority,
        typedInto: typedCard(terminal, chars, commands)
      })
      if (typedInputRefused({ commands, judged, card: card !== undefined }))
        throw toolRefusal(
          "A line uses editing keys (a cursor move with a delete, completion, history search or yank), so what it runs cannot be checked, and nothing was typed. Type the line plainly.",
          "Input unclear"
        )
      return card
    },
    approvalPrompt: async (input, ctx) => {
      const terminal = reachableTerminal(services.terminals, input.session_id, ctx.run)
      if (terminal === undefined) return { preview: "Type into a running command." }
      const chars = input.chars ?? ""
      const { commands } = typed(terminal, chars)
      const resolved = await terminalShell(services, terminal, ctx)
      const judged = commands.kind === "lines" ? (commands.judged ?? "") : chars
      return approvalPrompt({
        command: judged,
        resolved,
        ardenData: namesArdenData(services, judged, resolved),
        typedInto: typedCard(terminal, chars, commands)
      })
    },
    execute: async (input, ctx) => {
      const terminal = reachableTerminal(services.terminals, input.session_id, ctx.run)
      if (terminal === undefined) {
        throw toolRefusal(
          `No running command has session ID ${input.session_id} in this Chat. Start it again with exec_command.`,
          "Unknown session"
        )
      }
      const owned = terminal.sessionId === ctx.run.sessionId
      const chars = input.chars ?? ""
      const approved = ctx.approval?.data
      if (
        ctx.approval !== undefined &&
        (approved?.["typed_into"] !== terminal.toolCallId || approved["input"] !== chars)
      ) {
        throw toolRefusal(
          "The command or the input changed after it was approved. Request approval again.",
          "Input changed"
        )
      }
      if (ctx.run.approvalMode === "read_only" && chars.length > 0 && chars !== INTERRUPT) {
        throw refusalError({
          what: 'This run is read-only, so write_stdin can only read output or send "\\u0003" (Ctrl-C)',
          rule: "read_only",
          instead: refusalPath(ctx.run.authority.actor)
        })
      }
      if (chars.length > 0) {
        const { pending, commands } = typed(terminal, chars)
        if (commands.kind === "lines" && commands.judged !== undefined)
          await refuseNeverPaths(
            commands.judged,
            terminal.cwd,
            await sessionPathPolicy(services, {
              sessionId: ctx.run.sessionId,
              runId: ctx.run.runId,
              signal: ctx.signal
            })
          )
        const written = services.terminals.write(input.session_id, chars)
        if (written === "stdin_closed") {
          throw toolRefusal(
            `Session ${input.session_id} was started without tty, so it cannot read input. Only "\\u0003" (Ctrl-C) reaches it; start the command again with tty=true to answer prompts.`,
            "Input closed"
          )
        }
        if (written === "sent")
          pendingLines.set(terminal.id, { toolCallId: terminal.toolCallId, line: pending })
      }
      const wait =
        chars.length > 0
          ? Math.min(input.yield_time_ms ?? DEFAULT_WRITE_YIELD_MS, MAX_EXEC_YIELD_MS)
          : Math.min(
              Math.max(input.yield_time_ms ?? MIN_POLL_YIELD_MS, MIN_POLL_YIELD_MS),
              MAX_EXEC_YIELD_MS
            )
      await services.terminals.wait(input.session_id, { ms: wait, signal: ctx.signal })
      const read = services.terminals.read(input.session_id, owned ? undefined : ctx.run.sessionId)
      if (read === undefined) {
        throw toolRefusal(`Session ${input.session_id} is no longer available.`, "Unknown session")
      }
      return {
        result: [
          processState(input.session_id, read.exit),
          ...(read.omitted === 0 ? [] : [`[${read.omitted} earlier characters were dropped]`]),
          read.output.length === 0 ? "(no new output)" : `Output:\n${read.output}`
        ].join("\n"),
        preview: read.exit === undefined ? "Still running" : exitPreview(read.exit),
        data: {
          session_id: input.session_id,
          state: read.exit === undefined ? "running" : "exited",
          ...(read.exit?.kind === "code" ? { exit_code: read.exit.code } : {})
        }
      }
    }
  })
}

const terminalShell = async (
  services: ShellToolServices,
  terminal: TerminalInfo,
  ctx: { readonly run: ServerRunContext; readonly signal: AbortSignal }
): Promise<Pick<ResolvedShell, "cwd" | "access" | "codeAgent">> => {
  const session = await sessionPathPolicy(services, {
    sessionId: ctx.run.sessionId,
    runId: ctx.run.runId,
    signal: ctx.signal
  })
  return {
    cwd: terminal.cwd,
    access: terminal.access,
    codeAgent: session.sandbox === "code_agent"
  }
}

const typedCard = (terminal: TerminalInfo, chars: string, commands: TypedCommands) => ({
  command: terminal.command,
  toolCallId: terminal.toolCallId,
  input: chars,
  shown: commands.kind === "lines" ? commands.shown : chars,
  unknown: commands.kind === "lines" && commands.unknown
})

const reachableTerminal = (
  terminals: TerminalStore,
  id: number,
  run: ServerRunContext
): TerminalInfo | undefined => {
  const terminal = terminals.get(id)
  if (terminal === undefined || terminal.sessionId === run.sessionId) return terminal
  return sharedResourceSessions(run.authority, "agent_code").some(
    (resource) => resource.session_id === terminal.sessionId
  )
    ? terminal
    : undefined
}

const namesArdenData = (
  services: ShellToolServices,
  command: string,
  resolved: Pick<ResolvedShell, "cwd" | "access">
): boolean =>
  resolved.access === "host" &&
  mentionsArdenData({ command, cwd: resolved.cwd, roots: ardenDataRoots(services.dataDir) })

const commandCard = async (
  services: ShellToolServices,
  input: {
    readonly command: string
    readonly resolved: Pick<ResolvedShell, "cwd" | "access" | "codeAgent">
    readonly mode: ChatApprovalMode
    readonly authority: RunAuthority
    readonly plan?: (rules: RunRules) => Promise<HostCommandGrantPlan | undefined>
    readonly typedInto?: TypedInto
  }
): Promise<ServerApprovalPrompt | undefined> => {
  const { command, resolved } = input
  if (resolved.access === "sandbox") return undefined
  const ardenData = namesArdenData(services, command, resolved)
  const rules = await Effect.runPromise(readRunRules(services.rules, input.authority)).catch(
    () => undefined
  )
  const alwaysAsk = rules === undefined || ruleDecision(rules, matchesHostCommands) === "ask"
  const skips = commandSkipsCard({
    access: resolved.access,
    mode: input.mode,
    alwaysAsk,
    readsOnly:
      input.typedInto?.unknown !== true &&
      isReadOnlyCommand(parseCommandSegments(command), resolved.cwd),
    codeAgent: resolved.codeAgent,
    ardenData
  })
  const plan = rules === undefined ? undefined : await input.plan?.(rules)
  const need = hostCommandNeed({
    hostAsk: alwaysAsk,
    rule: plan?.rule,
    modeSkips: skips,
    systemJob: isSystemJobRun(input.authority)
  })
  if (need === "refuse")
    throw toolRefusal(
      `The user's rule says Arden never runs ${plan?.displayPrefixes.join(", ") ?? "this command"} on their Mac. Do not try another way; say what you needed instead.`,
      "A rule refuses this command"
    )
  if (need === "unlisted")
    throw toolRefusal(
      "No rule for Arden's own jobs allows this command, so it was not run. Do not try another way; say which command you needed and that the owner can allow it for Arden's own jobs.",
      "No rule allows this command"
    )
  if (need === "none" || input.mode === "read_only") return undefined
  return approvalPrompt({
    command,
    resolved,
    plan,
    ardenData,
    userOnly: need === "owner_card",
    typedInto: input.typedInto
  })
}

const processState = (id: number, exit: ProcessExit | undefined): string => {
  if (exit === undefined) return `Process running with session ID ${id}.`
  return exit.kind === "code"
    ? `Process ${id} exited with code ${exit.code}.`
    : `Process ${id} was stopped (${exit.signal}).`
}

const exitPreview = (exit: ProcessExit): string =>
  exit.kind === "code" ? `Exit ${exit.code}` : "Stopped"

export const shellTools = Effect.gen(function* () {
  const services: ShellToolServices = {
    sessions: yield* SessionQueries,
    spaces: yield* SpaceStore,
    runs: yield* RunQueries,
    rules: yield* PermissionRules,
    artifacts: yield* ConversationArtifacts,
    dataDir: (yield* DataRoot).dir,
    terminals: yield* TerminalSessions
  }
  return [makeExecCommandTool(services), makeWriteStdinTool(services)]
})
