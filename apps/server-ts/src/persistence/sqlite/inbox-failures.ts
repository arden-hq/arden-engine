import { providerSentence } from "@arden-hq/protocol/chat"
import type { InboxFailureEntry } from "../inbox/store.js"
import { SPACE_ARCHIVED_PAUSE_LINE } from "./automation-auto-pause.js"
import { inArdenWords } from "../restart-notice.js"
import { sha256Hex } from "@arden-hq/std/hash"

const FAILURE_CAUSE_LIMIT = 200
const NO_FAILURE_REASON = "failed without a recorded reason"

export interface FailureRow {
  readonly space_id: string | null
  readonly id: number
  readonly task_id: string | null
  readonly chat_run_id: string | null
  readonly started_at: string
  readonly error: string | null
  readonly error_code: string | null
}

export interface PauseRow {
  readonly task_id: string
  readonly attempt_id: number
  readonly resumed: number
}

export interface SpacePauseRow {
  readonly delivery_id: string
  readonly task_id: string
  readonly created_at: string
}

export const collapseWhitespace = (value: string): string => {
  let output = ""
  let pendingSpace = false
  for (const character of value.trim()) {
    if (character.charCodeAt(0) <= 32) {
      pendingSpace = output.length > 0
      continue
    }
    if (pendingSpace) output += " "
    output += character
    pendingSpace = false
  }
  return output
}

const ERROR_CLASS_PREFIX = /^[A-Z][A-Za-z0-9]*(?:Error|Exception):\s+/

const PROVIDER_CAUSE: Readonly<Record<string, string>> = {
  provider_unavailable: "Couldn't reach the model provider",
  rate_limited: "The model provider asked Arden to slow down"
}

export const failureCause = (error: string | null, code: string | null = null): string => {
  const said = code === null ? undefined : PROVIDER_CAUSE[code]
  if (said !== undefined) return said
  if (code === "model_unavailable") {
    const sentence = providerSentence(error ?? "")
    if (sentence !== undefined) return sentence.slice(0, FAILURE_CAUSE_LIMIT)
  }
  for (const line of (error ?? "").split("\n")) {
    const normalized = collapseWhitespace(line).replace(ERROR_CLASS_PREFIX, "")
    if (normalized.length > 0) return normalized.slice(0, FAILURE_CAUSE_LIMIT)
  }
  return NO_FAILURE_REASON
}

export const timeValue = (value: string): number => Date.parse(value)

export const later = (left: string, right: string | null): string => {
  if (right === null) return left
  const leftTime = timeValue(left)
  const rightTime = timeValue(right)
  return Number.isFinite(rightTime) && (!Number.isFinite(leftTime) || rightTime > leftTime)
    ? right
    : left
}

const earlier = (left: string, right: string): string => {
  const leftTime = timeValue(left)
  const rightTime = timeValue(right)
  return Number.isFinite(rightTime) && (!Number.isFinite(leftTime) || rightTime < leftTime)
    ? right
    : left
}

export const unread = (at: string, readAt: string | undefined): boolean =>
  readAt === undefined || timeValue(readAt) < timeValue(at)

const pausesByAutomation = (
  rows: ReadonlyArray<PauseRow>
): ReadonlyMap<string, { readonly resumedThrough: number; readonly pausedThrough?: number }> => {
  const pauses = new Map<string, { resumedThrough: number; pausedThrough?: number }>()
  for (const row of rows) {
    const pause = pauses.get(row.task_id) ?? { resumedThrough: 0 }
    if (row.resumed === 1) pause.resumedThrough = Math.max(pause.resumedThrough, row.attempt_id)
    else pause.pausedThrough = Math.max(pause.pausedThrough ?? 0, row.attempt_id)
    pauses.set(row.task_id, pause)
  }
  return pauses
}

const failureDigest = (cause: string): string => sha256Hex(cause).slice(0, 16)

export const automationFailureEntries = (input: {
  readonly failures: ReadonlyArray<FailureRow>
  readonly pauses: ReadonlyArray<PauseRow>
  readonly spacePauses: ReadonlyArray<SpacePauseRow>
  readonly spaceTitles: ReadonlyMap<string, string>
  readonly marks: ReadonlyMap<string, string>
}): Array<InboxFailureEntry> => {
  const failureGroups = new Map<
    string,
    {
      readonly spaceId: string | null
      readonly automationId: string | null
      runId: string | null
      cause: string
      count: number
      firstAt: string
      lastAt: string
    }
  >()
  const pauses = pausesByAutomation(input.pauses)
  const pausedGroups = new Map<
    string,
    { readonly automationId: string; readonly through: number }
  >()
  for (const row of [...input.failures].sort((left, right) => left.id - right.id)) {
    const spaceId = row.space_id
    if (spaceId !== null && !input.spaceTitles.has(spaceId)) continue
    const taskId = row.task_id
    const pause = taskId === null ? undefined : pauses.get(taskId)
    if (pause !== undefined && row.id <= pause.resumedThrough) continue
    const paused =
      taskId !== null && pause?.pausedThrough !== undefined && row.id <= pause.pausedThrough
        ? { automationId: taskId, through: pause.pausedThrough }
        : undefined
    const cause = failureCause(row.error, row.error_code)
    const key =
      paused === undefined
        ? `failure:${spaceId ?? row.task_id ?? row.chat_run_id ?? row.id}:${failureDigest(cause)}`
        : `failure:paused:${paused.automationId}:${paused.through}`
    if (paused !== undefined) pausedGroups.set(key, paused)
    const current = failureGroups.get(key)
    if (current === undefined) {
      failureGroups.set(key, {
        spaceId,
        automationId: row.task_id,
        runId: row.chat_run_id,
        cause,
        count: 1,
        firstAt: row.started_at,
        lastAt: row.started_at
      })
    } else {
      current.count += 1
      current.firstAt = earlier(current.firstAt, row.started_at)
      current.lastAt = later(current.lastAt, row.started_at)
      if (paused !== undefined) {
        current.cause = cause
        current.runId = row.chat_run_id
      }
    }
  }
  const failureItems: Array<InboxFailureEntry> = [...failureGroups.entries()].map(
    ([key, item]) => ({
      source: "failure",
      key,
      groupKey: "failures",
      at: item.lastAt,
      counted: true,
      unread: unread(item.lastAt, input.marks.get(key)),
      readAt: input.marks.get(key),
      spaceId: item.spaceId ?? undefined,
      spaceTitle: item.spaceId === null ? undefined : input.spaceTitles.get(item.spaceId),
      automationTaskId: item.automationId ?? undefined,
      runId: item.runId ?? undefined,
      workflowRef: undefined,
      cause: pausedGroups.has(key)
        ? `${item.count === 1 ? "Paused" : `Paused after ${item.count} failed runs in a row`}: ${inArdenWords(item.cause)}`
        : inArdenWords(item.cause),
      runCount: item.count,
      firstAt: item.firstAt,
      lastAt: item.lastAt,
      automationPaused: pausedGroups.has(key)
    })
  )
  const spacePauseItems = input.spacePauses.map((row): InboxFailureEntry => {
    const key = `failure:space-paused:${row.task_id}:${row.delivery_id.slice(0, 16)}`
    return {
      source: "failure",
      key,
      groupKey: "failures",
      at: row.created_at,
      counted: true,
      unread: unread(row.created_at, input.marks.get(key)),
      readAt: input.marks.get(key),
      spaceId: undefined,
      spaceTitle: undefined,
      automationTaskId: row.task_id,
      runId: undefined,
      workflowRef: undefined,
      cause: SPACE_ARCHIVED_PAUSE_LINE,
      runCount: 0,
      firstAt: row.created_at,
      lastAt: row.created_at,
      automationPaused: true
    }
  })
  return [...failureItems, ...spacePauseItems]
}
