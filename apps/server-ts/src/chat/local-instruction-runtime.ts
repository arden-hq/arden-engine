import { isWithin } from "@arden-hq/std/paths"
import type {
  ChatMessage,
  ModelRequestMiddleware,
  ToolCallRequest,
  ToolResult
} from "@arden-hq/loop"
import { Option, Schema } from "effect"
import type { ChatRunnerInput } from "./runner-contract.js"
import { appendDeveloperContext } from "./developer-context.js"
import { localTargetOf } from "../execution/local-target.js"
import {
  localInstructionManifest,
  renderLocalInstructions,
  type LocalInstructionManifestEntry,
  type LocalInstructionSnapshot
} from "../context/local-instructions.js"

const MAX_ACTIVE_DIRECTORIES = 8
const MAX_RECORDED_SOURCES = 24 * (MAX_ACTIVE_DIRECTORIES + 1)

const evidenceSchema = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      root: Schema.String,
      path: Schema.String,
      scope: Schema.String,
      status: Schema.Literals(["loaded", "empty", "unreadable", "truncated"]),
      digest: Schema.NullOr(Schema.String)
    })
  ).check(Schema.isMaxLength(MAX_RECORDED_SOURCES)),
  directories: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_ACTIVE_DIRECTORIES))
})

type LocalInstructionEvidence = {
  readonly sources: ReadonlyArray<LocalInstructionManifestEntry>
  readonly directories: ReadonlyArray<string>
}

export type LocalInstructionLoader = (input: {
  readonly sessionId: string
  readonly runId: string
  readonly signal: AbortSignal
  readonly target?: string
  readonly targetKind?: "directory" | "file"
}) => PromiseLike<LocalInstructionSnapshot | undefined>

export type LocalInstructionRecorder = (input: {
  readonly runId: string
  readonly sources: ReadonlyArray<LocalInstructionManifestEntry>
}) => PromiseLike<void>

export const makeLocalInstructionRuntime = ({
  load,
  record,
  input
}: {
  readonly load: LocalInstructionLoader
  readonly record: LocalInstructionRecorder | undefined
  readonly input: Pick<ChatRunnerInput, "sessionId" | "runId" | "turnId" | "signal">
}): {
  readonly modelMiddleware: ModelRequestMiddleware
  readonly preflight: (
    request: ToolCallRequest,
    host: Readonly<Record<string, unknown>> | undefined
  ) => Promise<ToolResult | undefined>
} => {
  const activeDirectories = new Set<string>()
  let directoriesInitialized = false
  let recordedManifest: string | undefined
  const sourceKey = (source: LocalInstructionManifestEntry): string =>
    JSON.stringify([source.root, source.path, source.scope, source.status, source.digest])
  const snapshotFor = (target?: string, targetKind?: "directory" | "file") =>
    load({
      sessionId: input.sessionId,
      runId: input.runId,
      signal: input.signal,
      ...(target === undefined ? {} : { target }),
      ...(targetKind === undefined ? {} : { targetKind })
    })

  const activateDirectory = (directory: string): void => {
    if (activeDirectories.has(directory)) return
    const oldest = activeDirectories.values().next()
    if (activeDirectories.size >= MAX_ACTIVE_DIRECTORIES && oldest.done !== true)
      activeDirectories.delete(oldest.value)
    activeDirectories.add(directory)
  }

  const decodeEvidence = Schema.decodeUnknownOption(evidenceSchema)
  const initializeDirectories = (messages: ReadonlyArray<ChatMessage> | undefined): void => {
    if (directoriesInitialized || messages === undefined) return
    directoriesInitialized = true
    const latest = messages.findLast(
      (message) =>
        message.role === "developer" && message.arden_context_source === "local_instructions"
    )
    const evidence = decodeEvidence(latest?.arden_local_instruction_evidence)
    if (Option.isNone(evidence)) return
    const current = [...activeDirectories]
    activeDirectories.clear()
    evidence.value.directories.forEach(activateDirectory)
    for (const directory of current) {
      activeDirectories.delete(directory)
      activateDirectory(directory)
    }
  }
  const restorePresented = (request: ToolCallRequest): LocalInstructionEvidence | undefined => {
    initializeDirectories(request.messages)
    const messages = request.messages ?? []
    const callIndex = messages.findLastIndex(
      (message) =>
        message.role === "assistant" &&
        message.tool_calls?.some((call) => call.id === request.toolCallId)
    )
    const previous = messages
      .slice(0, Math.max(0, callIndex))
      .findLast(
        (message) =>
          message.role === "developer" && message.arden_context_source === "local_instructions"
      )
    if (previous === undefined) return undefined
    const evidence = decodeEvidence(previous.arden_local_instruction_evidence)
    if (Option.isNone(evidence)) return undefined
    return evidence.value
  }

  const modelMiddleware: ModelRequestMiddleware = async (request, next) => {
    initializeDirectories(request.messages)
    const snapshots = await Promise.all([
      snapshotFor(),
      ...[...activeDirectories].map((directory) => snapshotFor(directory))
    ])
    if (record !== undefined) {
      const sources = localInstructionManifest(
        snapshots.filter((snapshot) => snapshot !== undefined)
      )
      const manifest = JSON.stringify(sources)
      if (manifest !== recordedManifest) {
        await record({ runId: input.runId, sources })
        recordedManifest = manifest
      }
    }
    const sections = snapshots.flatMap((snapshot) => {
      const rendered = renderLocalInstructions(snapshot)
      if (snapshot === undefined || rendered === undefined) return []
      return [rendered]
    })
    const evidence = {
      sources: localInstructionManifest(snapshots.filter((snapshot) => snapshot !== undefined)).map(
        (source) => ({ ...source })
      ),
      directories: [...activeDirectories]
    }
    const prepared = await next(request)
    return appendDeveloperContext({
      request: prepared,
      input,
      source: "local_instructions",
      content: sections.join("\n\n"),
      metadata: { arden_local_instruction_evidence: evidence }
    })
  }

  const preflight = async (
    request: ToolCallRequest,
    host: Readonly<Record<string, unknown>> | undefined
  ): Promise<ToolResult | undefined> => {
    const localTarget = localTargetOf(host)
    if (localTarget === undefined) return undefined
    const evidence = restorePresented(request)
    const target = (request.approval?.edited?.arguments ?? request.args)[localTarget.arg]
    if (target !== undefined && typeof target !== "string") return undefined
    const snapshot = await snapshotFor(target, localTarget.kind)
    if (snapshot === undefined) return undefined
    const current = localInstructionManifest([snapshot])
    const applicable = (evidence?.sources ?? []).filter(
      (source) =>
        source.root === snapshot.root &&
        isWithin(snapshot.instructionRoot, source.scope) &&
        isWithin(source.scope, snapshot.directory)
    )
    const presented = new Set(applicable.map(sourceKey))
    const unseen =
      (evidence === undefined && current.length > 0) ||
      applicable.length !== current.length ||
      current.some((source) => !presented.has(sourceKey(source)))
    if (!unseen) return undefined
    activateDirectory(snapshot.directory)
    if (host?.["action"] === "read") return undefined
    return {
      content: `Local folder instructions for ${snapshot.directory} changed or were not yet shown. No operation ran. Review the new instructions and retry this call.`,
      preview: "Read Local folder instructions before retrying",
      is_error: true,
      retryable: true
    }
  }
  return { modelMiddleware, preflight }
}
