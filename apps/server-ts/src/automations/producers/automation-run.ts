import { clipLine } from "@arden-hq/std/text"
import type {
  AutomationTriggerEvent,
  EndedAutomationRun
} from "../../persistence/automations/model.js"
import type { AutomationEventProducer } from "../event-producer.js"
import { causedChainDepth, wakeChainDepth } from "../../persistence/automations/chain-depth.js"
import { isUserAutomationPurpose } from "../../persistence/job-classification.js"

const REPORT_CHARS = 1_000

export const automationRunEndedEvent = (
  run: EndedAutomationRun
): AutomationTriggerEvent | undefined => {
  const text = clipLine(run.text, REPORT_CHARS)
  return {
    eventType: isUserAutomationPurpose(run.purpose)
      ? "automation.run_ended"
      : "automation.system_run_ended",
    eventKey: String(run.attemptId),
    producedBy: run.automationId,
    chainDepth: causedChainDepth(run.automationId, wakeChainDepth(run.wokenBy)),
    context: {
      run: {
        automation: run.name,
        automation_ref: run.automationRef,
        outcome: run.outcome,
        attempt_id: run.attemptId,
        report: text,
        ...(run.chat === undefined
          ? {}
          : { session_id: run.chat.sessionId, session_ref: run.chat.publicRef })
      }
    }
  }
}

export const runEndedEventProducer: AutomationEventProducer<"automation.run_ended"> = {
  eventType: "automation.run_ended",
  source: { kind: "feed" },
  failureMessage: "Automation run-ended trigger failed"
}

export const systemRunEndedEventProducer: AutomationEventProducer<"automation.system_run_ended"> = {
  eventType: "automation.system_run_ended",
  source: { kind: "feed" },
  failureMessage: "Built-in Automation run-ended trigger failed"
}
