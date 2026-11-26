import { isActiveRunStatus, RUN_STATUS } from "@arden-hq/protocol/runs"
import { TOOL_STATUS, type ToolStatus } from "./status-sets.js"
import { RETRY_VERDICT, type RetryVerdict } from "../scripts/journal.js"
import {
  WORKFLOW_EFFECT,
  WORKFLOW_PREVIEW,
  type WorkflowEffectDisposition,
  type WorkflowError,
  type WorkflowSourceRef
} from "@arden-hq/protocol/workflows"
import type { Schema } from "effect"

import { scriptResultText } from "../workflows/script-identity.js"
import type { ScriptResultPayload } from "../scripts/results.js"
import { boundedSourceRefs } from "../workflows/source-refs.js"
import { sha256Hex } from "@arden-hq/std/hash"

export const CALL_CHANGE = {
  none: "none",
  arden: "arden",
  applied: "applied",
  uncertain: "uncertain"
} as const
export type CallChange = (typeof CALL_CHANGE)[keyof typeof CALL_CHANGE]

export const NESTED_RETRY = { reuse: "reuse", rerun: "rerun", refuse: "refuse" } as const
export type NestedRetry = (typeof NESTED_RETRY)[keyof typeof NESTED_RETRY]

export const callEffect = (change: CallChange): WorkflowEffectDisposition => {
  switch (change) {
    case CALL_CHANGE.none:
    case CALL_CHANGE.arden:
      return "none"
    case CALL_CHANGE.applied:
      return "applied"
    case CALL_CHANGE.uncertain:
      return "unknown"
  }
}

export const mergeEffectDisposition = (
  current: WorkflowEffectDisposition,
  next: WorkflowEffectDisposition
): WorkflowEffectDisposition => {
  if (current === WORKFLOW_EFFECT.applied || next === WORKFLOW_EFFECT.applied) return "applied"
  if (current === WORKFLOW_EFFECT.unknown || next === WORKFLOW_EFFECT.unknown) return "unknown"
  if (current === WORKFLOW_EFFECT.no_op || next === WORKFLOW_EFFECT.no_op) return "no_op"
  return "none"
}

type UnsafeEffect = "applied" | "unknown"

const isUnsafeEffect = (effect: WorkflowEffectDisposition): effect is UnsafeEffect =>
  effect === WORKFLOW_EFFECT.applied || effect === WORKFLOW_EFFECT.unknown

export interface ScriptChildId {
  readonly key: string
  readonly launch: number | undefined
}

export const nextLaunch = (children: ReadonlyArray<Pick<ScriptChild, "id">>): number =>
  children.reduce((next, child) => Math.max(next, (child.id.launch ?? -1) + 1), 0)

export const SCRIPT_CHILD_RUN = {
  active: "active",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
  cancelled: "cancelled",
  missing: "missing"
} as const

export type ScriptChildRun =
  | { readonly status: typeof SCRIPT_CHILD_RUN.active }
  | { readonly status: typeof SCRIPT_CHILD_RUN.completed; readonly text: string | undefined }
  | {
      readonly status:
        | typeof SCRIPT_CHILD_RUN.failed
        | typeof SCRIPT_CHILD_RUN.interrupted
        | typeof SCRIPT_CHILD_RUN.cancelled
    }
  | { readonly status: typeof SCRIPT_CHILD_RUN.missing }

export const scriptChildRun = (
  runStatus: string | undefined,
  text: string | undefined
): ScriptChildRun => {
  if (runStatus === undefined) return { status: "missing" }
  if (runStatus === RUN_STATUS.completed) return { status: "completed", text }
  if (runStatus === RUN_STATUS.interrupted || runStatus === RUN_STATUS.cancelled)
    return { status: runStatus }
  if (isActiveRunStatus(runStatus)) return { status: "active" }
  return { status: "failed" }
}

export interface ScriptChild {
  readonly toolCallId: string
  readonly id: ScriptChildId
  readonly run: ScriptChildRun
  readonly effect: WorkflowEffectDisposition
  readonly sourceRefs: ReadonlyArray<WorkflowSourceRef>
}

export type OutputVerdict =
  | { readonly valid: true; readonly value: Schema.Json }
  | { readonly valid: false }

export const AGENT_REUSE = { reuse: "reuse", launch: "launch", refuse: "refuse" } as const

export type AgentReuseDecision =
  | {
      readonly kind: typeof AGENT_REUSE.reuse
      readonly toolCallId: string
      readonly value: Schema.Json
    }
  | {
      readonly kind: typeof AGENT_REUSE.launch
      readonly because: "first" | "retry" | "output_missing"
    }
  | {
      readonly kind: typeof AGENT_REUSE.refuse
      readonly toolCallId: string
      readonly effect: UnsafeEffect
    }

export const agentReuseDecision = (
  children: ReadonlyArray<ScriptChild>,
  check: (text: string) => OutputVerdict
): AgentReuseDecision => {
  for (const child of [...children].reverse()) {
    if (child.run.status !== SCRIPT_CHILD_RUN.completed || child.run.text === undefined) continue
    const verdict = check(child.run.text)
    if (verdict.valid) return { kind: "reuse", toolCallId: child.toolCallId, value: verdict.value }
  }
  const unsafe = children.flatMap((child) =>
    isUnsafeEffect(child.effect) ? [{ toolCallId: child.toolCallId, effect: child.effect }] : []
  )[0]
  if (unsafe !== undefined) return { kind: "refuse", ...unsafe }
  if (children.length === 0) return { kind: "launch", because: "first" }
  const outputMissing = children.some(
    (child) => child.run.status === SCRIPT_CHILD_RUN.completed && child.run.text === undefined
  )
  return { kind: "launch", because: outputMissing ? "output_missing" : "retry" }
}

const agentRetryEffect = (children: ReadonlyArray<ScriptChild>): WorkflowEffectDisposition => {
  const latest = new Map<string, ScriptChild>()
  for (const child of children) latest.set(child.id.key, child)
  return children.reduce<WorkflowEffectDisposition>((effect, child) => {
    const reused = latest.get(child.id.key)?.run.status === SCRIPT_CHILD_RUN.completed
    return reused ? effect : mergeEffectDisposition(effect, child.effect)
  }, "none")
}

export interface NestedCall {
  readonly status: ToolStatus
  readonly isError: boolean
  readonly change: CallChange
}

export const nestedRetryDecision = (call: NestedCall): NestedRetry => {
  if (call.status === TOOL_STATUS.completed && !call.isError) return "reuse"
  if (call.status === TOOL_STATUS.ready || call.status === TOOL_STATUS.paused) return "rerun"
  return isUnsafeEffect(callEffect(call.change)) ? "refuse" : "rerun"
}

export const nestedRerunId = (base: string, attempt: number): string => `${base}:r${attempt}`

export interface NestedRun {
  readonly base: string
  readonly attempt: number
}

export const nestedRuns = <A extends { readonly toolCallId: string }>(
  calls: ReadonlyArray<A>,
  attempts: number
): ReadonlyArray<A & NestedRun> => {
  const reruns = new Map<string, NestedRun>()
  for (const call of calls)
    for (let attempt = 1; attempt <= attempts; attempt += 1)
      reruns.set(nestedRerunId(call.toolCallId, attempt), { base: call.toolCallId, attempt })
  return calls.map((call) => ({
    ...call,
    ...(reruns.get(call.toolCallId) ?? { base: call.toolCallId, attempt: 1 })
  }))
}

export const latestNestedRuns = <A extends NestedRun>(
  calls: ReadonlyArray<A>
): ReadonlyArray<A> => {
  const latest = new Map<string, A>()
  for (const call of calls) {
    const prior = latest.get(call.base)
    if (prior === undefined || call.attempt > prior.attempt) latest.set(call.base, call)
  }
  return [...latest.values()]
}

export const retryVerdict = (input: {
  readonly children: ReadonlyArray<ScriptChild>
  readonly nested: ReadonlyArray<NestedCall & NestedRun & { readonly toolCallId: string }>
}): RetryVerdict => {
  const agents = agentRetryEffect(input.children)
  if (isUnsafeEffect(agents)) return { kind: RETRY_VERDICT.refuse, effect: agents }
  const refused = latestNestedRuns(input.nested).find(
    (call) => nestedRetryDecision(call) === NESTED_RETRY.refuse
  )
  if (refused === undefined) return { kind: RETRY_VERDICT.allow }
  const effect = callEffect(refused.change)
  return {
    kind: RETRY_VERDICT.refuse,
    effect: effect === WORKFLOW_EFFECT.applied ? WORKFLOW_EFFECT.applied : WORKFLOW_EFFECT.unknown
  }
}

export interface ScriptResultInput {
  readonly workflowRef: string
  readonly attempt: number
  readonly sessionId: string
  readonly sessionRef: string
  readonly originRunId: string
  readonly status: ScriptResultPayload["status"]
  readonly value: Schema.Json
  readonly error: WorkflowError | null
  readonly sourceRefs: ReadonlyArray<WorkflowSourceRef>
}

interface ScriptResultRow {
  readonly deliveryId: string
  readonly body: string
  readonly payload: ScriptResultPayload
  readonly inboxKey: string
}

export const scriptResultRow = (input: ScriptResultInput): ScriptResultRow => ({
  deliveryId: scriptResultDeliveryId(input),
  body: scriptResultText(input),
  payload: {
    kind: "script_result",
    sessionId: input.sessionId,
    sessionRef: input.sessionRef,
    originRunId: input.originRunId,
    workflowRef: input.workflowRef,
    attempt: input.attempt,
    status: input.status,
    preview: input.error?.preview.kind === WORKFLOW_PREVIEW.line ? input.error.preview.text : null,
    sourceRefs: boundedSourceRefs(input.sourceRefs)
  },
  inboxKey: `failure:workflow:${input.workflowRef}:${input.attempt}`
})

export const scriptResultDeliveryId = (script: {
  readonly workflowRef: string
  readonly attempt: number
}): string => sha256Hex(`script-result:${script.workflowRef}:${script.attempt}`)
