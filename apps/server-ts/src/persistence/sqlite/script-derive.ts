import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import type { WorkflowEffectDisposition, WorkflowSourceRef } from "@arden-hq/protocol/workflows"
import type { Schema } from "effect"

import { scriptResultText } from "../workflows/script-identity.js"
import type { ScriptResultPayload } from "../scripts/results.js"
import { boundedSourceRefs } from "../workflows/source-refs.js"
import { sha256Hex } from "@arden-hq/std/hash"

export type CallChange = "none" | "arden" | "applied" | "uncertain"

export const callEffect = (change: CallChange): WorkflowEffectDisposition => {
  switch (change) {
    case "none":
    case "arden":
      return "none"
    case "applied":
      return "applied"
    case "uncertain":
      return "unknown"
  }
}

export const mergeEffectDisposition = (
  current: WorkflowEffectDisposition,
  next: WorkflowEffectDisposition
): WorkflowEffectDisposition => {
  if (current === "applied" || next === "applied") return "applied"
  if (current === "unknown" || next === "unknown") return "unknown"
  if (current === "no_op" || next === "no_op") return "no_op"
  return "none"
}

type UnsafeEffect = "applied" | "unknown"

const isUnsafeEffect = (effect: WorkflowEffectDisposition): effect is UnsafeEffect =>
  effect === "applied" || effect === "unknown"

export const scriptChildPrefix = (originToolCallId: string): string =>
  `${originToolCallId}:workflow:`

export type ScriptChildId =
  | { readonly attempt: undefined; readonly key: string; readonly launch: number }
  | { readonly attempt: number; readonly key: string; readonly launch: undefined }

const DIGITS = /^\d+$/u

export const parseScriptChildId = (
  originToolCallId: string,
  toolCallId: string
): ScriptChildId | undefined => {
  const prefix = scriptChildPrefix(originToolCallId)
  if (!toolCallId.startsWith(prefix)) return undefined
  const parts = toolCallId.slice(prefix.length).split(":")
  const counters = parts.slice(-2)
  const key = parts.at(-3)
  if (key === undefined || key.length === 0 || !counters.every((part) => DIGITS.test(part))) {
    return undefined
  }
  if (parts.length === 3) return { attempt: undefined, key, launch: Number(parts[2]) }
  const attempt = parts[0]
  if (parts.length === 4 && attempt !== undefined && DIGITS.test(attempt)) {
    return { attempt: Number(attempt), key, launch: undefined }
  }
  return undefined
}

export const nextLaunch = (children: ReadonlyArray<Pick<ScriptChild, "id">>): number =>
  children.reduce((next, child) => Math.max(next, (child.id.launch ?? -1) + 1), 0)

export type ScriptChildRun =
  | { readonly status: "active" }
  | { readonly status: "completed"; readonly text: string | undefined }
  | { readonly status: "failed" | "interrupted" | "cancelled" }
  | { readonly status: "missing" }

export const scriptChildRun = (
  runStatus: string | undefined,
  text: string | undefined
): ScriptChildRun => {
  if (runStatus === undefined) return { status: "missing" }
  if (runStatus === "completed") return { status: "completed", text }
  if (runStatus === "interrupted" || runStatus === "cancelled") return { status: runStatus }
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

export type AgentReuseDecision =
  | { readonly kind: "reuse"; readonly toolCallId: string; readonly value: Schema.Json }
  | { readonly kind: "launch"; readonly because: "first" | "retry" | "output_missing" }
  | { readonly kind: "refuse"; readonly toolCallId: string; readonly effect: UnsafeEffect }

export const agentReuseDecision = (
  children: ReadonlyArray<ScriptChild>,
  check: (text: string) => OutputVerdict
): AgentReuseDecision => {
  for (const child of [...children].reverse()) {
    if (child.run.status !== "completed" || child.run.text === undefined) continue
    const verdict = check(child.run.text)
    if (verdict.valid) return { kind: "reuse", toolCallId: child.toolCallId, value: verdict.value }
  }
  const unsafe = children.flatMap((child) =>
    isUnsafeEffect(child.effect) ? [{ toolCallId: child.toolCallId, effect: child.effect }] : []
  )[0]
  if (unsafe !== undefined) return { kind: "refuse", ...unsafe }
  if (children.length === 0) return { kind: "launch", because: "first" }
  const outputMissing = children.some(
    (child) => child.run.status === "completed" && child.run.text === undefined
  )
  return { kind: "launch", because: outputMissing ? "output_missing" : "retry" }
}

const agentRetryEffect = (children: ReadonlyArray<ScriptChild>): WorkflowEffectDisposition => {
  const latest = new Map<string, ScriptChild>()
  for (const child of children) latest.set(child.id.key, child)
  return children.reduce<WorkflowEffectDisposition>((effect, child) => {
    const reused = latest.get(child.id.key)?.run.status === "completed"
    return reused ? effect : mergeEffectDisposition(effect, child.effect)
  }, "none")
}

export interface NestedCall {
  readonly status: "running" | "ready" | "completed" | "paused" | "uncertain"
  readonly isError: boolean
  readonly change: CallChange
}

export const nestedRetryDecision = (call: NestedCall): "reuse" | "rerun" | "refuse" => {
  if (call.status === "completed" && !call.isError) return "reuse"
  if (call.status === "ready" || call.status === "paused") return "rerun"
  return isUnsafeEffect(callEffect(call.change)) ? "refuse" : "rerun"
}

const RERUN = /^(.*):r(\d+)$/u

export const nestedRun = (
  toolCallId: string
): { readonly base: string; readonly attempt: number } => {
  const match = RERUN.exec(toolCallId)
  return match === null || match[1] === undefined || match[2] === undefined
    ? { base: toolCallId, attempt: 1 }
    : { base: match[1], attempt: Number(match[2]) }
}

export const nestedRerunId = (base: string, attempt: number): string => `${base}:r${attempt}`

export const latestNestedRuns = <A extends { readonly toolCallId: string }>(
  calls: ReadonlyArray<A>
): ReadonlyArray<A> => {
  const latest = new Map<string, { readonly attempt: number; readonly call: A }>()
  for (const call of calls) {
    const run = nestedRun(call.toolCallId)
    const prior = latest.get(run.base)
    if (prior === undefined || run.attempt > prior.attempt) latest.set(run.base, { ...run, call })
  }
  return [...latest.values()].map((entry) => entry.call)
}

export const retryVerdict = (input: {
  readonly children: ReadonlyArray<ScriptChild>
  readonly nested: ReadonlyArray<NestedCall & { readonly toolCallId: string }>
}): { readonly kind: "allow" } | { readonly kind: "refuse"; readonly effect: UnsafeEffect } => {
  const agents = agentRetryEffect(input.children)
  if (isUnsafeEffect(agents)) return { kind: "refuse", effect: agents }
  const refused = latestNestedRuns(input.nested).find(
    (call) => nestedRetryDecision(call) === "refuse"
  )
  if (refused === undefined) return { kind: "allow" }
  const effect = callEffect(refused.change)
  return { kind: "refuse", effect: effect === "applied" ? "applied" : "unknown" }
}

export interface ScriptResultInput {
  readonly workflowRef: string
  readonly attempt: number
  readonly sessionId: string
  readonly sessionRef: string
  readonly originRunId: string
  readonly status: ScriptResultPayload["status"]
  readonly value: Schema.Json
  readonly error: { readonly message: string; readonly preview?: string } | null
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
    preview: input.error?.preview ?? null,
    sourceRefs: boundedSourceRefs(input.sourceRefs)
  },
  inboxKey: `failure:workflow:${input.workflowRef}:${input.attempt}`
})

export const scriptResultDeliveryId = (script: {
  readonly workflowRef: string
  readonly attempt: number
}): string => sha256Hex(`script-result:${script.workflowRef}:${script.attempt}`)
