import {
  MESSAGE_PREVIEW,
  recoverBy,
  WORKFLOW_EFFECT,
  WORKFLOW_ERROR_CODE,
  WORKFLOW_STATUS
} from "@arden-hq/protocol/workflows"
import { RETRY_VERDICT, type RetryVerdict } from "../persistence/scripts/journal.js"
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
    recovery: recoverBy("retry"),
    preview: MESSAGE_PREVIEW
  },
  sourceRefs: []
}

const isTransient = (settlement: ScriptSettlement): boolean =>
  settlement.status === WORKFLOW_STATUS.failed &&
  settlement.error?.retryable === true &&
  (settlement.error.code === WORKFLOW_ERROR_CODE.agent_failed ||
    settlement.error.code === WORKFLOW_ERROR_CODE.interrupted)

export const ATTEMPT_STEP = { settle: "settle", check: "check", retry: "retry" } as const

export const RETRY_CAUSE = { attempt: "attempt", restart: "restart" } as const

export type AttemptStep =
  | { readonly kind: typeof ATTEMPT_STEP.settle; readonly settlement: ScriptSettlement }
  | { readonly kind: typeof ATTEMPT_STEP.check }
  | {
      readonly kind: typeof ATTEMPT_STEP.retry
      readonly delayMs: number
      readonly counted: boolean
    }

export const attemptStep = (input: {
  readonly cause: (typeof RETRY_CAUSE)[keyof typeof RETRY_CAUSE]
  readonly settlement: ScriptSettlement
  readonly autoRetries: number
  readonly verdict: RetryVerdict | undefined
}): AttemptStep => {
  const restart = input.cause === RETRY_CAUSE.restart
  if (!restart && (!isTransient(input.settlement) || input.autoRetries >= MAX_AUTO_RETRIES)) {
    return { kind: ATTEMPT_STEP.settle, settlement: input.settlement }
  }
  if (input.verdict === undefined) return { kind: ATTEMPT_STEP.check }
  if (input.verdict.kind === RETRY_VERDICT.allow) {
    return restart
      ? { kind: ATTEMPT_STEP.retry, delayMs: outboxRetryDelayMs(1), counted: false }
      : {
          kind: ATTEMPT_STEP.retry,
          delayMs: outboxRetryDelayMs(input.autoRetries + 1),
          counted: true
        }
  }
  const failure = input.settlement.error?.message ?? "The script failed"
  return {
    kind: ATTEMPT_STEP.settle,
    settlement: {
      ...input.settlement,
      status: "needs_attention",
      error: {
        code: "uncertain_effect",
        message: `${failure}. It did not run again by itself: an earlier step ${
          input.verdict.effect === WORKFLOW_EFFECT.applied ? "changed" : "may have changed"
        } something outside Arden.`,
        retryable: false,
        recovery: recoverBy("review what it changed before retrying"),
        preview: MESSAGE_PREVIEW
      }
    }
  }
}
