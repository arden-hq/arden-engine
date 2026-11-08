import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"
import { Schema } from "effect"

import type { ChatSendInput } from "../chat/message-input.js"
import type { TerminalInfo } from "./store.js"
import { writeAtomicSync } from "@arden-hq/std/atomic-file"
import { signalProcessGroup } from "@arden-hq/std/process"

const RunningCommandSchema = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  id: Schema.Number,
  pid: Schema.optionalKey(Schema.Number),
  command: Schema.String,
  approvalMode: ApprovalModeSchema,
  startedAt: Schema.Number
})
type RunningCommand = typeof RunningCommandSchema.Type
const NoticeSchema = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  id: Schema.Number,
  command: Schema.String,
  approvalMode: RunningCommandSchema.fields.approvalMode,
  clientId: Schema.String,
  content: Schema.String,
  outcome: Schema.Literals(["completed", "failed", "cancelled"] as const)
})
export type TerminalNotice = typeof NoticeSchema.Type
const ManifestSchema = Schema.Struct({
  running: Schema.Array(RunningCommandSchema),
  pending: Schema.Array(NoticeSchema)
})
type Manifest = typeof ManifestSchema.Type
const decodeManifest = Schema.decodeUnknownSync(ManifestSchema)
const decodeRunning = Schema.decodeUnknownSync(Schema.Array(RunningCommandSchema))

export const terminalsFile = (dir: string): string => join(dir, "terminals.json")

export const takeRestartNotices = (dir: string): ReadonlyArray<ChatSendInput> => {
  const file = terminalsFile(dir)
  const manifest = readManifest(file)
  const pending = new Map(
    manifest.pending.map((notice) => [JSON.stringify([notice.sessionId, notice.clientId]), notice])
  )
  for (const command of manifest.running) {
    stopOrphan(command)
    const notice: TerminalNotice = {
      sessionId: command.sessionId,
      toolCallId: command.toolCallId,
      id: command.id,
      command: command.command,
      approvalMode: command.approvalMode,
      clientId: `terminal-restart:${command.toolCallId}`,
      content: `Arden restarted while the command was detached: \`${command.command}\` (session ${command.id}). Its session ID no longer works. Check the command's effects before deciding whether to run it again.`,
      outcome: "cancelled"
    }
    pending.set(JSON.stringify([notice.sessionId, notice.clientId]), notice)
  }
  writeManifest(file, { running: [], pending: [...pending.values()] })
  return [...pending.values()].map(noticeInput)
}

export const pendingTerminalNotices = (file: string): ReadonlyArray<TerminalNotice> =>
  readManifest(file).pending

export const enqueueTerminalNotice = (file: string, notice: TerminalNotice): void => {
  const manifest = readManifest(file)
  const pending = new Map(
    manifest.pending.map((item) => [JSON.stringify([item.sessionId, item.clientId]), item])
  )
  pending.set(JSON.stringify([notice.sessionId, notice.clientId]), notice)
  writeManifest(file, { ...manifest, pending: [...pending.values()] })
}

export const acknowledgeTerminalNotice = (
  file: string,
  sessionId: string,
  clientId: string
): void => {
  const manifest = readManifest(file)
  writeManifest(file, {
    ...manifest,
    pending: manifest.pending.filter(
      (notice) => notice.sessionId !== sessionId || notice.clientId !== clientId
    )
  })
}

export const noticeInput = (notice: TerminalNotice): ChatSendInput => ({
  sessionId: notice.sessionId,
  clientId: notice.clientId,
  approvalMode: notice.approvalMode,
  message: notice.content,
  isMeta: true,
  interaction: {
    kind: "completion",
    from: { type: "tool", id: `exec_command:${notice.id}`, display_name: notice.command },
    to: { type: "agent", id: notice.sessionId },
    content: notice.content,
    outcome: notice.outcome,
    causedBy: { type: "tool_call", id: notice.toolCallId }
  }
})

const readManifest = (file: string): Manifest => {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { running: [], pending: [] }
    throw cause
  }
  const value: unknown = JSON.parse(text)
  return Array.isArray(value)
    ? { running: decodeRunning(value), pending: [] }
    : decodeManifest(value)
}

const writeManifest = (file: string, manifest: Manifest): void => {
  writeAtomicSync(file, JSON.stringify(manifest))
}

export const writeRunning = (file: string, terminals: ReadonlyArray<TerminalInfo>): void => {
  const running: ReadonlyArray<RunningCommand> = terminals.map((terminal) => ({
    sessionId: terminal.sessionId,
    toolCallId: terminal.toolCallId,
    id: terminal.id,
    ...(terminal.pid === undefined ? {} : { pid: terminal.pid }),
    command: terminal.command,
    approvalMode: terminal.approvalMode,
    startedAt: terminal.startedAt
  }))
  writeManifest(file, { ...readManifest(file), running })
}

const stopOrphan = (command: RunningCommand): void => {
  if (command.pid === undefined || process.platform === "win32") return
  let commandLine: string
  try {
    commandLine = execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(command.pid)], {
      encoding: "utf8"
    })
  } catch {
    return
  }
  if (!commandLine.includes(command.command.slice(0, 80))) return
  signalProcessGroup(command.pid, "SIGKILL")
}
