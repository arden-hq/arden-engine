import { cutText } from "@arden-hq/std/text"
import type { InteractionOutcome } from "@arden-hq/protocol/chat"
import type { EndingRecord } from "./ending.js"
import type { ChatRunRecord } from "./model.js"

export interface ParentCompletion {
  readonly outcome: InteractionOutcome
  readonly label: string
  readonly text: string
  readonly reportState: "available" | "missing" | "no_change" | "waiting" | "damaged"
}

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

const completionOf = ({
  status,
  stopReason,
  ending,
  noChangeReason
}: ParentCompletionInput): ParentCompletion => {
  const text = ending?.text.trim() === "" ? "" : (ending?.text ?? "")
  if (status === "cancelled" || ending?.status === "cancelled")
    return {
      outcome: "cancelled",
      label: "cancelled",
      text: text || "Worker cancelled.",
      reportState: ending?.detail === "damaged" ? "damaged" : "available"
    }
  if (status === "interrupted" && stopReason === "server_restart")
    return {
      outcome: "interrupted",
      label: "interrupted",
      text:
        text ||
        "Worker was interrupted by a server restart. Its assignment is not confirmed complete.",
      reportState: ending?.detail === "damaged" ? "damaged" : "available"
    }
  if (status === "error" || status === "interrupted" || ending?.status === "failed")
    return {
      outcome: "failed",
      label: "failed",
      text: text || "Worker failed without an error report.",
      reportState: ending?.detail === "damaged" ? "damaged" : "available"
    }
  if (ending?.detail === "damaged")
    return { outcome: "needs_attention", label: "needs attention", text, reportState: "damaged" }
  if (ending?.status === "waiting")
    return {
      outcome: "needs_attention",
      label: "waiting",
      text: text || "Worker is waiting for an answer or approval.",
      reportState: "waiting"
    }
  if (ending?.status === "silent" && ending.detail === "no_change")
    return {
      outcome: stopReason === null || stopReason === "end_turn" ? "completed" : "needs_attention",
      label: "reported no change",
      text: [`No change reported.${noChangeReason === undefined ? "" : ` ${noChangeReason}`}`, text]
        .filter((line) => line !== "")
        .join("\n"),
      reportState: "no_change"
    }
  if (
    ending === undefined ||
    text === "" ||
    (ending.status === "silent" && ending.detail === "empty")
  )
    return {
      outcome: "needs_attention",
      label: "missing report",
      text: "Worker ended without a completion report. Inspect its run before claiming the assignment is complete.",
      reportState: "missing"
    }
  if (ending.status !== "finished" || (stopReason !== null && stopReason !== "end_turn"))
    return { outcome: "needs_attention", label: "needs attention", text, reportState: "available" }
  return { outcome: "completed", label: "completed", text, reportState: "available" }
}
