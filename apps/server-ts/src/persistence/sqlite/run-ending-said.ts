import { AUTOMATION_RUN_OUTCOME, type AutomationRunOutcome } from "@arden-hq/protocol/automations"
import { isUserAutomationPurpose, type JobPurpose } from "../job-classification.js"
import { told, waitsOnOwner, type Readable } from "./owner-update.js"
import type { EndedAutomationRun } from "./automation-run-outcome.js"
import {
  ENDING_DETAIL,
  ENDING_PURPOSE,
  ENDING_STATUS,
  PLACE_KIND,
  type EndingDetail,
  type EndingPurpose,
  type EndingRecord,
  type EndingStatus
} from "../runs/ending.js"

export type ToldOutcome =
  | typeof AUTOMATION_RUN_OUTCOME.finished
  | typeof AUTOMATION_RUN_OUTCOME.needs_you
  | typeof AUTOMATION_RUN_OUTCOME.blocked
  | typeof AUTOMATION_RUN_OUTCOME.failed

export const RUN_TERMINAL = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
} as const

export type RunTerminal =
  | { readonly status: typeof RUN_TERMINAL.completed; readonly result: string }
  | { readonly status: typeof RUN_TERMINAL.failed; readonly error: string }
  | { readonly status: typeof RUN_TERMINAL.cancelled }

export const ENDING = { run: "run", occurrence: "occurrence" } as const

export type Ending =
  | {
      readonly kind: typeof ENDING.run
      readonly runId: string
      readonly terminal: RunTerminal
      readonly now: string
      readonly occurredAt?: string
    }
  | {
      readonly kind: typeof ENDING.occurrence
      readonly purpose: JobPurpose
      readonly run: EndedAutomationRun
    }

interface ShownFacts {
  readonly repeats?: boolean
  readonly news?: boolean
  readonly changed?: boolean
  readonly twinExists?: boolean
  readonly recurring?: boolean
  readonly cancelledTask?: boolean
}

export const shown = (
  record: Readable,
  {
    twinExists = false,
    recurring = false,
    cancelledTask = false,
    repeats = false,
    news = false,
    changed = false
  }: ShownFacts = {}
): boolean => {
  if (!told(record) || twinExists) return false
  switch (record.purpose) {
    case ENDING_PURPOSE.chat:
      return record.status === ENDING_STATUS.finished || record.status === ENDING_STATUS.failed
    case ENDING_PURPOSE.userAutomation:
      return record.status !== ENDING_STATUS.finished || !repeats || news || changed
    case ENDING_PURPOSE.taskExecution:
      return (
        (record.status === ENDING_STATUS.finished && cancelledTask && !recurring) ||
        (record.status === ENDING_STATUS.blocked && waitsOnOwner(record.detail))
      )
    case ENDING_PURPOSE.system:
    case ENDING_PURPOSE.spaceReview:
      return false
  }
}

export const tellShown = (record: Pick<Readable, "purpose" | "placeKind">): boolean =>
  record.placeKind === PLACE_KIND.chat && record.purpose !== ENDING_PURPOSE.system

const DAMAGED_RUN = "The worker's record is damaged, so its result could not be read."

export interface Facts {
  readonly quiet: boolean
  readonly news: boolean
  readonly changed: boolean
  readonly ask: string | null
  readonly askLine: string
  readonly blockedKind: string | null
}

export interface Said {
  readonly status: EndingStatus
  readonly detail: string | null
  readonly text: string
}

const silent = (detail: EndingDetail | AutomationRunOutcome, text = ""): Said => ({
  status: ENDING_STATUS.silent,
  detail,
  text
})

export const saidOf = (input: {
  readonly ending: Ending
  readonly purpose: EndingPurpose
  readonly facts: Facts
  readonly agent: boolean
}): Said => {
  const { ending } = input
  if (ending.kind === ENDING.run) return saidOfRun(ending.terminal, input.agent, input.facts)
  return saidOfOccurrence(ending.run, input.purpose, input.facts)
}

const saidOfRun = (terminal: RunTerminal, agent: boolean, facts: Facts): Said => {
  switch (terminal.status) {
    case RUN_TERMINAL.cancelled:
      return { status: "cancelled", detail: null, text: agent ? "Worker cancelled." : "" }
    case RUN_TERMINAL.failed:
      return terminal.error.trim() === "" && !agent
        ? silent(ENDING_DETAIL.empty)
        : { status: "failed", detail: null, text: terminal.error }
    case RUN_TERMINAL.completed:
      if (facts.ask !== null)
        return {
          status: "waiting",
          detail: facts.ask,
          text: agent ? `Waiting for the owner's answer: ${facts.askLine}` : terminal.result
        }
      if (facts.quiet) return silent(ENDING_DETAIL.noChange, terminal.result)
      if (terminal.result.trim() === "") return silent(ENDING_DETAIL.empty)
      return { status: "finished", detail: null, text: terminal.result }
  }
}

const saidOfOccurrence = (run: EndedAutomationRun, purpose: EndingPurpose, facts: Facts): Said => {
  switch (run.outcome) {
    case AUTOMATION_RUN_OUTCOME.failed:
      return { status: "failed", detail: null, text: run.error ?? run.result ?? "The run failed." }
    case AUTOMATION_RUN_OUTCOME.finished:
      if (facts.ask !== null)
        return { status: "waiting", detail: facts.ask, text: run.result ?? "" }
      return run.result === null || run.result.trim() === ""
        ? silent(ENDING_DETAIL.empty)
        : { status: "finished", detail: null, text: run.result }
    case AUTOMATION_RUN_OUTCOME.blocked:
      return run.result === null || run.result.trim() === ""
        ? silent(ENDING_DETAIL.empty)
        : { status: "blocked", detail: facts.blockedKind, text: run.result }
    case AUTOMATION_RUN_OUTCOME.needs_you:
      if (facts.ask !== null)
        return { status: "waiting", detail: facts.ask, text: run.result ?? "" }
      return isUserAutomationPurpose(purpose) || purpose === ENDING_PURPOSE.taskExecution
        ? { status: "blocked", detail: ENDING_DETAIL.needsYou, text: run.result ?? "" }
        : silent(ENDING_DETAIL.needsYou, run.result ?? "")
    case AUTOMATION_RUN_OUTCOME.cancelled:
      return { status: "cancelled", detail: null, text: "" }
    case AUTOMATION_RUN_OUTCOME.no_change:
    case AUTOMATION_RUN_OUTCOME.interrupted:
    case AUTOMATION_RUN_OUTCOME.superseded:
    case AUTOMATION_RUN_OUTCOME.skipped_prefilter:
    case AUTOMATION_RUN_OUTCOME.skipped_space_review_gate:
      return silent(run.outcome, run.result ?? "")
  }
}

export const saidDamaged = (ending: Ending): Said => {
  const terminal: RunTerminal =
    ending.kind === ENDING.run ? ending.terminal : { status: RUN_TERMINAL.failed, error: "" }
  switch (terminal.status) {
    case RUN_TERMINAL.cancelled:
      return { status: "cancelled", detail: ENDING_DETAIL.damaged, text: DAMAGED_RUN }
    case RUN_TERMINAL.failed:
      return {
        status: "failed",
        detail: ENDING_DETAIL.damaged,
        text: `${DAMAGED_RUN} ${terminal.error}`.trim()
      }
    case RUN_TERMINAL.completed:
      return { status: "finished", detail: ENDING_DETAIL.damaged, text: DAMAGED_RUN }
  }
}

export const toldOutcomeOf = (
  record: EndingRecord | undefined,
  run: EndedAutomationRun
): { readonly outcome: ToldOutcome; readonly text: string } | undefined => {
  if (record === undefined)
    return run.outcome === AUTOMATION_RUN_OUTCOME.failed
      ? { outcome: "failed", text: run.error ?? run.result ?? "The run failed." }
      : undefined
  switch (record.status) {
    case ENDING_STATUS.finished:
      return { outcome: "finished", text: record.text }
    case ENDING_STATUS.blocked:
      return {
        outcome: record.detail === ENDING_DETAIL.needsYou ? "needs_you" : "blocked",
        text: record.text
      }
    case ENDING_STATUS.waiting:
      return { outcome: "needs_you", text: record.text }
    case ENDING_STATUS.failed:
      return { outcome: "failed", text: record.text }
    case ENDING_STATUS.silent:
      return record.detail === ENDING_DETAIL.empty &&
        (run.outcome === AUTOMATION_RUN_OUTCOME.finished ||
          run.outcome === AUTOMATION_RUN_OUTCOME.blocked)
        ? { outcome: run.outcome, text: "" }
        : undefined
    case ENDING_STATUS.cancelled:
      return undefined
  }
}
