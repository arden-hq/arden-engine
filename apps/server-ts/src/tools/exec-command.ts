import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { commandTarget } from "./action-targets.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { PermissionRules } from "../persistence/permissions/rules.js"
import { COMMAND_TOOL } from "../persistence/permissions/command-policy.js"
import { ConversationArtifacts } from "../artifacts/conversation.js"
import { sessionLineage } from "../persistence/sessions/lineage.js"
import { changesNothing } from "./bash-safe-commands.js"
import { commandCard, namesArdenData } from "./command-card.js"
import { refuseNeverPaths } from "./command-paths.js"
import { approvalPrompt, commandGrantPlan, networkReach, workingDirectory } from "./shell-policy.js"
import {
  keyProxyFor,
  shellRuntime,
  type ShellRuntime,
  type ShellRuntimeOptions
} from "./shell-invocation.js"
import {
  EMPTY_LINE,
  INTERRUPT,
  typedCommands,
  typedInputJudged,
  typedInputRefused,
  typeInto,
  type TypedLine
} from "./typed-input.js"
import { sessionPathPolicy } from "../storage/local-paths.js"
import { ServerConfig } from "../config/service.js"
import { DataRoot } from "../runtime/data-root.js"
import { resolveCommandSandbox } from "../runtime/command-sandbox.js"
import { CommandInterrupted, runCommandUntil } from "./shell-run.js"
import { TerminalSessions } from "../terminals/service.js"
import type { TerminalInfo } from "../terminals/store.js"
import { spawnLiveProcess } from "../terminals/live-process.js"
import { refusalPath } from "../execution/decide.js"
import { refusalError } from "./refusal.js"
import { toolRefusal } from "./tool-failure.js"
import { VaultKeys } from "../credentials/vault-keys.js"
import {
  DEFAULT_WRITE_YIELD_MS,
  DEFAULT_YIELD_MS,
  ExecParametersSchema,
  MAX_EXEC_YIELD_MS,
  MIN_POLL_YIELD_MS,
  WriteParametersSchema,
  type ShellToolServices
} from "./exec-command-parameters.js"
import {
  exitPreview,
  exitedResult,
  processState,
  reachableTerminal,
  terminalShell,
  typedCard
} from "./exec-command-support.js"

const makeExecCommandTool = (
  services: ShellToolServices,
  options: ShellRuntimeOptions = {}
): ServerTool => {
  const runtime = async (): Promise<ShellRuntime> =>
    shellRuntime({ commandSandbox: await resolveCommandSandbox(), ...options })
  const tool: ServerTool = defineServerTool({
    name: COMMAND_TOOL,
    summary: "Runs a command in a terminal on your Mac.",
    discovery: "always_loaded",
    description: [
      "Run one Bash command in a fresh local process.",
      "If it finishes within yield_time_ms you get its output; a non-zero exit fails the call with the output and the exit code. If it is still running (a dev server, a watcher, a long build, a prompt), you get the output so far and a session ID; the process keeps running and you can read it, type into it, or stop it with write_stdin.",
      "No shell state persists between calls. Prefer file_read, file_list, file_find, file_search_text, file_write, and file_edit for ordinary file work.",
      "Decide before you write the command: keep cmd to a few short lines. A file's content, a multi-step script or embedded data goes into a file with file_write first, and cmd only runs or uses that file. Do not put such text in a heredoc, echo or an inline script: file_write takes far more text than a command may hold.",
      "Ordinary Chats default to host access; code agents default to their own folder's sandbox. A sandboxed command needs a workdir inside a folder a rule lets Arden change.",
      "The sandbox reads the whole machine except secret folders (ssh and gpg keys, cloud logins, keychains, browser profiles, Arden's data), so installed CLIs, virtualenvs and toolchains run; it writes only its Local folder and temporary directories, has no network, and may list processes but signal only ones it started.",
      "When a command needs more, run it again with the narrowest escalation instead of working around the sandbox: access=network when it only needs the network (a download, a package install, git over https, an API); access=host when it needs ssh, the user's saved logins or keys, Git config or a new repository (git init, clone, worktree add, remote add, git config; on macOS add, commit, branch, checkout and stash work in the sandbox), or changes outside the Local folder. Both follow the approval mode.",
      `Approved network access reaches ${networkReach()}.`,
      "Host access runs with no sandbox, with the user's HOME and PATH but without credential environment variables, and follows the chat's approval mode (the user may require their own approval for every host command). In a run no one is watching (an Automation, a Task's job, an agent a chat started), a host command that needs approval does not run then: its card waits for the user in this run's chat, and approving it runs the command. Skip it, finish the rest, and say in your report that it waits on the user's approval.",
      "Cancellation after the process starts can leave side effects with unknown outcome, so inspect state before retrying."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ExecParametersSchema),
    metadata: {
      display: [
        { fact: "card", value: "command" },
        { fact: "refresh", value: "terminals" }
      ],
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
      const shell = {
        ...(await runtime()),
        keyProxy: await keyProxyFor(services.vault, ctx.run.runId, access)
      }
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
    summary: "Types into a command that is already running.",
    discovery: "always_loaded",
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

export const shellTools = Effect.gen(function* () {
  const services: ShellToolServices = {
    sessions: yield* SessionQueries,
    spaces: yield* SpaceStore,
    runs: yield* RunQueries,
    rules: yield* PermissionRules,
    vault: yield* VaultKeys,
    artifacts: yield* ConversationArtifacts,
    dataDir: (yield* DataRoot).dir,
    terminals: yield* TerminalSessions,
    commandSandbox: (yield* ServerConfig).commandSandbox
  }
  return [makeExecCommandTool(services), makeWriteStdinTool(services)]
})
