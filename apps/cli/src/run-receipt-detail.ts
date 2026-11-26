import type { RunDetail, RunTerminalResult } from "@arden-hq/headless"
import type { CommandReceiptV1, DeclinedRequest } from "./run.js"
import {
  PROVIDER_COST,
  RUN_CLIENT,
  RUN_FAILURE,
  RUN_MODEL,
  RUN_REASONING,
  RUN_RESULT,
  RUN_STOP_REASON,
  RUN_STATUS,
  runHasEnded
} from "@arden-hq/protocol/runs"
import { CONTEXT_SIZE } from "@arden-hq/protocol/chat"

interface ReceiptUsage {
  readonly prompt: number
  readonly completion: number
  readonly total: number
  readonly cache_read: number
  readonly cache_write: number
  readonly cost?: number
}

export interface ReceiptResult {
  readonly text: string
  readonly data: RunTerminalResult["data"]
  readonly usage: ReceiptUsage
  readonly cost?: number
  readonly duration_ms: number
  readonly tool_time_ms: number
  readonly steps: number
  readonly last_input_tokens: number | null
}

export interface ReceiptRun {
  readonly client_id: string | null
  readonly model_id: string | null
  readonly reasoning_effort: string | null
  readonly stop_reason: string | null
  readonly result: ReceiptResult | null
  readonly error: { readonly code: string; readonly message: string } | null
}

const receiptResult = (result: RunTerminalResult): ReceiptResult => {
  const cost = result.usage.cost.kind === PROVIDER_COST.reported ? result.usage.cost.usd : undefined
  const priced = cost === undefined ? {} : { cost }
  return {
    text: result.text,
    data: result.data,
    usage: {
      prompt: result.usage.prompt,
      completion: result.usage.completion,
      total: result.usage.total,
      cache_read: result.usage.cache_read,
      cache_write: result.usage.cache_write,
      ...priced
    },
    ...priced,
    duration_ms: result.duration_ms,
    tool_time_ms: result.tool_time_ms,
    steps: result.steps,
    last_input_tokens:
      result.context.kind === CONTEXT_SIZE.measured ? result.context.input_tokens : null
  }
}

const receiptRun = (detail: RunDetail): ReceiptRun => {
  const identity = {
    client_id: detail.client.kind === RUN_CLIENT.client ? detail.client.client_id : null,
    model_id: detail.model.kind === RUN_MODEL.model ? detail.model.model_id : null,
    reasoning_effort:
      detail.reasoning.kind === RUN_REASONING.effort ? detail.reasoning.effort : null
  }
  if (!runHasEnded(detail)) {
    return { ...identity, stop_reason: null, result: null, error: null }
  }
  return {
    ...identity,
    stop_reason:
      detail.stop_reason.kind === RUN_STOP_REASON.stated ? detail.stop_reason.reason : null,
    result: detail.result.kind === RUN_RESULT.none ? null : receiptResult(detail.result.result),
    error:
      detail.failure.kind === RUN_FAILURE.failed
        ? { code: detail.failure.code, message: detail.failure.message }
        : null
  }
}

export const receiptFromRun = (
  command: CommandReceiptV1["command"],
  detail: RunDetail,
  declined: ReadonlyArray<DeclinedRequest>
): CommandReceiptV1 => {
  const run = receiptRun(detail)
  const base = {
    version: 1,
    type: "command_receipt",
    command,
    run_id: detail.run_id,
    session_id: detail.session_id,
    client_id: run.client_id,
    run_status: detail.status,
    model_id: run.model_id,
    reasoning_effort: run.reasoning_effort,
    declined
  } as const
  if (detail.status === RUN_STATUS.completed && run.result !== null) {
    return { ...base, status: "completed", exit_code: 0, result: run.result, error: null }
  }

  const error = run.error ?? {
    code: detail.status === RUN_STATUS.completed ? "missing_result" : detail.status,
    message:
      run.stop_reason ??
      (detail.status === RUN_STATUS.completed
        ? "Completed Run has no terminal result"
        : `Run ended with status ${detail.status}`)
  }
  return {
    ...base,
    status:
      detail.status === RUN_STATUS.cancelled || detail.status === RUN_STATUS.interrupted
        ? detail.status
        : "failed",
    exit_code: 1,
    result: null,
    error
  }
}
