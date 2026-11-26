import { makeFairReadWriteLock, PauseRequested } from "@arden-hq/loop"
import { Schema } from "effect"

import type { NestedCallFacts, ScriptAgentObserver, ScriptAgentRequest } from "./contract.js"
import { SCRIPT_PROGRESS_STATUS, nestedCallIds, type ScriptProgressTool } from "./nested-trace.js"
import { CODE_MODE_TOOL, NESTED_CALL_MARKERS } from "../../persistence/tools/tool-roles.js"
import { type ScriptProgress, type ScriptProgressAgent } from "./script-outcome.js"

const DEFAULT_MAX_AGENTS = 100
export const MAX_TOOL_CALLS = 1_000
const MAX_TOOL_CONCURRENCY = 4
export const MAX_PARALLEL_ITEMS = 4_096
export const MAX_BRANCH_NAME = 60
export const SCRIPT_TIMEOUT_MS = 30 * 60 * 1_000
export const SCRIPT_OUTPUT_BYTES = 8 * 1_024 * 1_024

interface ScriptToolRequest {
  readonly onResolved: (toolCallId: string) => void
  readonly onSettled: (facts: NestedCallFacts) => void
  readonly parentToolCallId: string
  readonly toolCallId: string
  readonly name: string
  readonly args: Readonly<Record<string, Schema.Json>>
  readonly phase?: string
  readonly signal: AbortSignal
}

export interface ScriptOptions {
  readonly code: string
  readonly args: Readonly<Record<string, Schema.Json>>
  readonly parentToolCallId: string
  readonly signal: AbortSignal
  readonly maxAgents?: number
  readonly executionProfileHash: string
  readonly timeoutMs?: number
  readonly agent: (
    request: ScriptAgentRequest,
    observer: ScriptAgentObserver
  ) => Promise<Schema.Json>
  readonly tool: (request: ScriptToolRequest) => Promise<Schema.Json>
  readonly changesState?: (name: string) => boolean
  readonly describe?: (name: string) => Schema.Json | undefined
  readonly concurrencyGroup?: ((name: string) => string | null) | undefined
  readonly onProgress?: (progress: ScriptProgress) => void
}

const groupLocks = () => {
  const locks = new Map<string, ReturnType<typeof makeFairReadWriteLock>>()
  return async <A>(
    group: string | null,
    options: { readonly write: boolean; readonly signal: AbortSignal },
    effect: () => Promise<A>
  ): Promise<A> => {
    if (group === null) return effect()
    const lock = locks.get(group) ?? makeFairReadWriteLock()
    locks.set(group, lock)
    const unlock = await lock.acquire(options.write)
    try {
      options.signal.throwIfAborted()
      return await effect()
    } finally {
      unlock()
    }
  }
}

export class ScriptLaunchBudgetError extends Error {}

const limiter = (limit: number) => {
  let active = 0
  const waiting: Array<() => void> = []
  return async <A>(effect: () => Promise<A>): Promise<A> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await effect()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

export interface ScriptRun {
  readonly options: ScriptOptions
  readonly maxAgents: number
  readonly argsJson: string
  readonly launches: { value: number }
  readonly reserveLaunch: () => number
  readonly progressAgents: Map<number, ScriptProgressAgent>
  readonly progressTools: Map<string, ScriptProgressTool>
  readonly progressPhases: string[]
  readonly phaseEntries: Map<string, { readonly id: string; readonly title: string }>
  readonly registerPhase: (id: string, title: string) => void
  readonly unreported: Set<string>
  readonly emitProgress: () => void
  readonly nestedCallId: ReturnType<typeof nestedCallIds>
  readonly toolCalls: string[]
  readonly limitTools: ReturnType<typeof limiter>
  readonly inGroup: ReturnType<typeof groupLocks>
  readonly halt: AbortController
  readonly halted: { value: PauseRequested | undefined }
}

export const makeScriptRun = (options: ScriptOptions): ScriptRun => {
  const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS
  const argsJson = JSON.stringify(options.args)
  const launches = { value: 0 }
  const reserveLaunch = (): number => {
    if (launches.value >= maxAgents) {
      throw new ScriptLaunchBudgetError("script child-launch budget exhausted")
    }
    launches.value += 1
    return launches.value
  }
  const progressAgents = new Map<number, ScriptProgressAgent>()
  const progressTools = new Map<string, ScriptProgressTool>()
  const progressPhases: string[] = []
  const phaseEntries = new Map<string, { readonly id: string; readonly title: string }>()
  const registerPhase = (id: string, title: string): void => {
    if (phaseEntries.has(id)) return
    phaseEntries.set(id, { id, title })
    progressPhases.push(title)
  }
  const unreported = new Set<string>()
  const emitProgress = (): void => {
    const tools = [...progressTools.values()].map((tool) => {
      if (unreported.has(tool.tool_call_id)) return tool
      const { source_refs: _sources, change_evidence: _changes, ...entry } = tool
      return entry
    })
    unreported.clear()
    options.onProgress?.({
      phase_entries: [...phaseEntries.values()],
      phases: [...progressPhases],
      agents: [...progressAgents.values()],
      tools
    })
  }
  const nestedCallId = nestedCallIds(options.parentToolCallId, NESTED_CALL_MARKERS[CODE_MODE_TOOL])
  const toolCalls: string[] = []
  const limitTools = limiter(MAX_TOOL_CONCURRENCY)
  const inGroup = groupLocks()
  const halt = new AbortController()
  const halted: { value: PauseRequested | undefined } = { value: undefined }
  return {
    options,
    maxAgents,
    argsJson,
    launches,
    reserveLaunch,
    progressAgents,
    progressTools,
    progressPhases,
    phaseEntries,
    registerPhase,
    unreported,
    emitProgress,
    nestedCallId,
    toolCalls,
    limitTools,
    inGroup,
    halt,
    halted
  }
}

const MAX_NOT_UNDONE_NAMES = 12

export const failureMessage = (
  message: string,
  line: number | undefined,
  tools: ReadonlyArray<Pick<ScriptProgressTool, "name" | "status" | "changes_state">>
): string => {
  const where = line === undefined ? "" : ` (script line ${line})`
  const counts = new Map<string, number>()
  for (const tool of tools) {
    if (tool.changes_state && tool.status !== SCRIPT_PROGRESS_STATUS.failed) {
      counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return `${message}${where}`
  const shown = [...counts].slice(0, MAX_NOT_UNDONE_NAMES)
  const names = shown.map(([name, count]) => (count > 1 ? `${name} x${count}` : name)).join(", ")
  const more = counts.size > shown.length ? `, and ${counts.size - shown.length} more` : ""
  return `${message}${where}. Already done before the failure and not undone: ${names}${more}.`
}

export type ScriptToolFailure = {
  readonly kind: "script_tool_result"
  readonly status: "failed"
  readonly message: string
  readonly preview?: string
}

export const toolFailure = (message: string, preview?: string): ScriptToolFailure =>
  ({
    kind: "script_tool_result",
    status: "failed",
    message,
    ...(preview === undefined ? {} : { preview })
  }) as const

export const optionalBoundedText = (
  value: Schema.Json | undefined,
  label: string,
  maxLength: number
): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`)
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`${label} must not be empty`)
  if (normalized.length > maxLength) {
    throw new TypeError(`${label} must be at most ${maxLength} characters`)
  }
  return normalized
}
