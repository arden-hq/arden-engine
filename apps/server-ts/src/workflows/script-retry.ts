import type { RetryVerdict } from "../persistence/scripts/journal.js"
import type { ScriptSettlement } from "../persistence/scripts/store.js"
import { outboxRetryDelayMs } from "../runtime/outbox.js"

const MAX_AUTO_RETRIES = 3

export const interruptedByRestart: ScriptSettlement = {
  status: "failed",
  value: null,
  error: {
    code: "interrupted",
    message: "Arden restarted while the script was running",
    retryable: true,
    recovery_action: "retry"
  },
  sourceRefs: []
}

const isTransient = (settlement: ScriptSettlement): boolean =>
  settlement.status === "failed" &&
  settlement.error?.retryable === true &&
  (settlement.error.code === "agent_failed" || settlement.error.code === "interrupted")

export type AttemptStep =
  | { readonly kind: "settle"; readonly settlement: ScriptSettlement }
  | { readonly kind: "check" }
  | { readonly kind: "retry"; readonly delayMs: number; readonly counted: boolean }

export const attemptStep = (input: {
  readonly cause: "attempt" | "restart"
  readonly settlement: ScriptSettlement
  readonly autoRetries: number
  readonly verdict: RetryVerdict | undefined
}): AttemptStep => {
  const restart = input.cause === "restart"
  if (!restart && (!isTransient(input.settlement) || input.autoRetries >= MAX_AUTO_RETRIES)) {
    return { kind: "settle", settlement: input.settlement }
  }
  if (input.verdict === undefined) return { kind: "check" }
  if (input.verdict.kind === "allow") {
    return restart
      ? { kind: "retry", delayMs: outboxRetryDelayMs(1), counted: false }
      : { kind: "retry", delayMs: outboxRetryDelayMs(input.autoRetries + 1), counted: true }
  }
  const failure = input.settlement.error?.message ?? "The script failed"
  return {
    kind: "settle",
    settlement: {
      ...input.settlement,
      status: "needs_attention",
      error: {
        code: "uncertain_effect",
        message: `${failure}. It did not run again by itself: an earlier step ${
          input.verdict.effect === "applied" ? "changed" : "may have changed"
        } something outside Arden.`,
        retryable: false,
        recovery_action: "review what it changed before retrying"
      }
    }
  }
}
