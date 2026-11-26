import { DateTime, Effect } from "effect"
import { CHAT_WRITE_STORED, type ChatWriteReceiveResult } from "../chat/store.js"
import { TOOL_PERSISTENCE_FAILED } from "../tools/store.js"
import { WorkStoreError } from "../work/store.js"
import { loadRun } from "./chat-run.js"
import { loadLiveSession, schedulingForSession } from "./chat-session.js"
import { writeError } from "./chat-write-errors.js"
import { loadReceipt } from "./chat-admission-receipt.js"
import { assertAutomationLease } from "./automation-lease.js"
import { liftOwedUpdate, readDeliveryForAdmission } from "./work-delivery-admission.js"
import { arrivalIdentitySql } from "./work-delivery-routing.js"
import { markOnboarding, onboardingRefusal } from "./session-onboarding.js"
import { claimQueued } from "./chat-queue.js"
import {
  DELIVERY_TARGET,
  type AdmissionContext,
  type AdmissionDeps,
  type DeliveryTarget
} from "./chat-admission-context.js"

export const admissionGate = Effect.fn("SqliteChatWriteStore.admissionGate")(function* (
  input: AdmissionContext & AdmissionDeps
) {
  const { valid, conflict, runtime, sql, sessionEvents, intelligence, limits } = input
  const controls = yield* intelligence.settings().pipe(
    Effect.mapError((cause) =>
      writeError("start", "storage", "Could not read agent settings", {
        sessionId: valid.sessionId,
        cause
      })
    )
  )
  const automationTokenLimit =
    valid.automation === undefined
      ? undefined
      : yield* limits.automationTokenCap(valid.automation.automationId).pipe(
          Effect.mapError((cause) =>
            writeError("start", "storage", "Could not read the plan limits", {
              sessionId: valid.sessionId,
              cause
            })
          )
        )
  const now = yield* DateTime.now
  const timestamp = DateTime.formatIso(now)
  const settleDelivery = (target: DeliveryTarget) => {
    if (valid.deliveryId === undefined || valid.clientId !== `arrival:${valid.deliveryId}`)
      return Effect.void
    const chatOrRun = target.kind === DELIVERY_TARGET.run ? target.runId : target.sessionId
    return sql`UPDATE automation_deliveries SET status = 'delivered', delivered_at = ${timestamp},
          destinations = ${JSON.stringify([`chat:${chatOrRun}`])}
          WHERE delivery_id = ${valid.deliveryId} AND status = 'pending'
            AND ${arrivalIdentitySql(sql, valid.sessionId, valid.message["content"])}`
  }
  const session = yield* loadLiveSession(sql, valid.sessionId)
  const preparing = yield* sql<{ readonly child_session_id: string }>`
            SELECT child_session_id FROM session_fork_requests
            WHERE child_session_id = ${valid.sessionId} AND state = 'preparing'
          `
  if (preparing.length !== 0) {
    return yield* conflict(
      "The chat fork is still preparing its files. Retry the fork before sending."
    )
  }
  if (valid.automation && valid.automationLease) {
    yield* assertAutomationLease(sql, {
      lease: valid.automationLease,
      ...valid.automation,
      sessionId: valid.sessionId
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof WorkStoreError
          ? conflict(cause.message)
          : writeError("start", "storage", "Could not inspect Automation lease", {
              sessionId: valid.sessionId,
              cause
            })
      )
    )
  }
  const claimed = yield* claimQueued(sql, {
    sessionId: valid.sessionId,
    clientId: valid.clientId,
    headOnly: valid.fromQueue === true
  })
  const scheduling = yield* schedulingForSession(
    sql,
    session.session_id,
    session.session_type,
    controls.maxConcurrentAgents,
    "start"
  )
  const receipt = yield* loadReceipt(
    sql,
    valid.sessionId,
    valid.clientId,
    valid.requestHash,
    valid.message
  )
  if (receipt === null && valid.fromQueue === true && !claimed)
    return yield* conflict("The queued message is no longer at the head", "queue_changed")
  if (receipt !== null) {
    if (receipt.run_id === null) {
      yield* settleDelivery({ kind: DELIVERY_TARGET.session, sessionId: valid.sessionId })
      return { done: { _tag: CHAT_WRITE_STORED.stored } satisfies ChatWriteReceiveResult }
    }
    const existingRun = yield* loadRun(sql, receipt.run_id, "start")
    if (existingRun.session_id !== valid.sessionId) {
      return yield* writeError("start", "corrupt", "Idempotency receipt points to another run", {
        sessionId: valid.sessionId,
        runId: receipt.run_id
      })
    }
    yield* settleDelivery({ kind: DELIVERY_TARGET.run, runId: receipt.run_id })
    return {
      done: {
        _tag: "Existing",
        runId: receipt.run_id,
        status: receipt.status
      } satisfies ChatWriteReceiveResult
    }
  }

  if (runtime === null) {
    return yield* conflict("The saved request expired before it could be replayed")
  }
  if (valid.opensOnboarding === true) {
    const refusal = yield* onboardingRefusal(sql, valid.sessionId).pipe(
      Effect.mapError((cause) =>
        writeError("start", "storage", "Could not check Getting started", {
          sessionId: valid.sessionId,
          cause
        })
      )
    )
    if (refusal !== undefined) return yield* conflict(refusal)
    yield* markOnboarding(sql, valid.sessionId, timestamp)
  }

  const arrivalConflict = (cause: { readonly message: string }) => conflict(cause.message)
  const delivery =
    valid.deliveryId === undefined
      ? undefined
      : yield* readDeliveryForAdmission({
          sql,
          deliveryId: valid.deliveryId,
          sessionId: valid.sessionId,
          admittedWith: valid.admittedWith ?? [],
          content: valid.message["content"]
        }).pipe(Effect.mapError(arrivalConflict))
  yield* liftOwedUpdate(sql, sessionEvents, delivery, timestamp)
  const blockedRuns = yield* sql<{ readonly run_id: string }>`
        SELECT run_id FROM chat_runs
        WHERE session_id = ${valid.sessionId}
          AND status = 'error'
          AND error_code = ${TOOL_PERSISTENCE_FAILED}
        LIMIT 1
      `
  if (blockedRuns.length > 0) {
    return yield* conflict("A tool persistence failure must be resolved before Chat can continue")
  }
  return {
    values: {
      runtime,
      automationTokenLimit,
      now,
      timestamp,
      settleDelivery,
      session,
      scheduling,
      arrivalConflict,
      delivery
    }
  }
})

export type GateValues = Extract<
  Effect.Success<ReturnType<typeof admissionGate>>,
  { readonly values: unknown }
>["values"]
