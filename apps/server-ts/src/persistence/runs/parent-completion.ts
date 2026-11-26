import { INTERACTION_OUTCOME } from "@arden-hq/std/message-vocabulary"
import { cutText } from "@arden-hq/std/text"
import type { InteractionOutcome } from "@arden-hq/protocol/chat"
import { StopReason } from "@arden-hq/loop"
import { RUN_STATUS } from "@arden-hq/protocol/runs"
import { ENDING_DETAIL, ENDING_STATUS, type EndingRecord } from "./ending.js"
import { SERVER_RESTART_STOP_REASON, type ChatRunRecord } from "./model.js"

export interface ParentCompletion {
  readonly outcome: InteractionOutcome
  readonly label: string
  readonly text: string
  readonly reportState: ReportState
}

const REPORT_STATE = {
  available: "available",
  missing: "missing",
  noChange: "no_change",
  waiting: "waiting",
  damaged: "damaged"
} as const

type ReportState = (typeof REPORT_STATE)[keyof typeof REPORT_STATE]

interface ParentCompletionInput extends Pick<ChatRunRecord, "runId" | "status" | "stopReason"> {
  readonly sessionRef: string
  readonly ending: Pick<EndingRecord, "status" | "detail" | "text"> | undefined
  readonly noChangeReason: string | undefined
}

export const parentCompletion = (input: ParentCompletionInput): ParentCompletion => {
  const report = completionOf(input)
  return {
    ...report,
    text: cutText(report.text, 24_000, {
      suffix: `\n[Report shortened. Inspect run_id ${JSON.stringify(input.runId)}; use session_read with session_ref ${JSON.stringify(input.sessionRef)} and view "actions" for execution evidence.]`
    })
  }
}

const reportStateOf = (ending: ParentCompletionInput["ending"]): ReportState =>
  ending?.detail === ENDING_DETAIL.damaged ? REPORT_STATE.damaged : REPORT_STATE.available

const finishedTurn = (stopReason: string | null): boolean =>
  stopReason === null || stopReason === StopReason.END_TURN

const completionOf = ({
  status,
  stopReason,
  ending,
  noChangeReason
}: ParentCompletionInput): ParentCompletion => {
  const text = ending?.text.trim() === "" ? "" : (ending?.text ?? "")
  if (status === RUN_STATUS.cancelled || ending?.status === ENDING_STATUS.cancelled)
    return {
      outcome: INTERACTION_OUTCOME.cancelled,
      label: "cancelled",
      text: text || "Worker cancelled.",
      reportState: reportStateOf(ending)
    }
  if (status === RUN_STATUS.interrupted && stopReason === SERVER_RESTART_STOP_REASON)
    return {
      outcome: INTERACTION_OUTCOME.interrupted,
      label: "interrupted",
      text:
        text ||
        "Worker was interrupted by a server restart. Its assignment is not confirmed complete.",
      reportState: reportStateOf(ending)
    }
  if (
    status === RUN_STATUS.error ||
    status === RUN_STATUS.interrupted ||
    ending?.status === ENDING_STATUS.failed
  )
    return {
      outcome: INTERACTION_OUTCOME.failed,
      label: "failed",
      text: text || "Worker failed without an error report.",
      reportState: reportStateOf(ending)
    }
  if (ending?.detail === ENDING_DETAIL.damaged)
    return {
      outcome: INTERACTION_OUTCOME.needsAttention,
      label: "needs attention",
      text,
      reportState: REPORT_STATE.damaged
    }
  if (ending?.status === ENDING_STATUS.waiting)
    return {
      outcome: INTERACTION_OUTCOME.needsAttention,
      label: "waiting",
      text: text || "Worker is waiting for an answer or approval.",
      reportState: REPORT_STATE.waiting
    }
  if (ending?.status === ENDING_STATUS.silent && ending.detail === ENDING_DETAIL.noChange)
    return {
      outcome: finishedTurn(stopReason)
        ? INTERACTION_OUTCOME.completed
        : INTERACTION_OUTCOME.needsAttention,
      label: "reported no change",
      text: [`No change reported.${noChangeReason === undefined ? "" : ` ${noChangeReason}`}`, text]
        .filter((line) => line !== "")
        .join("\n"),
      reportState: REPORT_STATE.noChange
    }
  if (
    ending === undefined ||
    text === "" ||
    (ending.status === ENDING_STATUS.silent && ending.detail === ENDING_DETAIL.empty)
  )
    return {
      outcome: INTERACTION_OUTCOME.needsAttention,
      label: "missing report",
      text: "Worker ended without a completion report. Inspect its run before claiming the assignment is complete.",
      reportState: REPORT_STATE.missing
    }
  if (ending.status !== ENDING_STATUS.finished || !finishedTurn(stopReason))
    return {
      outcome: INTERACTION_OUTCOME.needsAttention,
      label: "needs attention",
      text,
      reportState: REPORT_STATE.available
    }
  return {
    outcome: INTERACTION_OUTCOME.completed,
    label: "completed",
    text,
    reportState: REPORT_STATE.available
  }
}
