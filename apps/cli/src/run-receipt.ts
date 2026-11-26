import { type ReceiptResult, type ReceiptRun } from "./run-receipt-detail.js"
import { type HeadlessRunEvent, type RunDetail, type SubmittedRun } from "@arden-hq/headless"

import { type CliDependencies } from "./command.js"
import { progressLines } from "./terminal.js"

import {
  CLI_OUTPUT_FORMAT,
  RECEIPT_STATUS,
  type CliOutputFormat,
  type ReceiptStatus
} from "./cli-words.js"

export type { CliOutputFormat }

export interface CommandReceiptError {
  readonly code: string
  readonly message: string
}

export interface DeclinedRequest {
  readonly kind: "approval" | "connection"
  readonly tool_id: string
  readonly name: string
}

export interface CommandReceiptV1 {
  readonly version: 1
  readonly type: "command_receipt"
  readonly command: "run" | "wait"
  readonly status: ReceiptStatus
  readonly exit_code: number
  readonly run_id: string | null
  readonly session_id: string | null
  readonly client_id: string | null
  readonly run_status: RunDetail["status"] | null
  readonly model_id: ReceiptRun["model_id"]
  readonly reasoning_effort: ReceiptRun["reasoning_effort"]
  readonly result: ReceiptResult | null
  readonly error: CommandReceiptError | null
  readonly declined: ReadonlyArray<DeclinedRequest>
}

export interface ReceiptIdentity {
  readonly runId: string | null
  readonly sessionId: string | null
  readonly clientId: string | null
}

export const noIdentity: ReceiptIdentity = { runId: null, sessionId: null, clientId: null }

export const failedReceipt = (
  command: CommandReceiptV1["command"],
  error: CommandReceiptError,
  input: {
    readonly identity?: ReceiptIdentity
    readonly status?: CommandReceiptV1["status"]
    readonly exitCode?: number
    readonly declined?: ReadonlyArray<DeclinedRequest>
  } = {}
): CommandReceiptV1 => {
  const identity = input.identity ?? noIdentity
  return {
    version: 1,
    type: "command_receipt",
    command,
    status: input.status ?? "failed",
    exit_code: input.exitCode ?? 1,
    run_id: identity.runId,
    session_id: identity.sessionId,
    client_id: identity.clientId,
    run_status: null,
    model_id: null,
    reasoning_effort: null,
    result: null,
    error,
    declined: input.declined ?? []
  }
}

export const submittedReceipt = (run: SubmittedRun): CommandReceiptV1 => ({
  version: 1,
  type: "command_receipt",
  command: "run",
  status: "submitted",
  exit_code: 0,
  run_id: run.runId,
  session_id: run.sessionId,
  client_id: run.clientId,
  run_status: null,
  model_id: null,
  reasoning_effort: null,
  result: null,
  error: null,
  declined: []
})

export const invalidInputReceipt = (
  command: CommandReceiptV1["command"],
  message: string
): CommandReceiptV1 => failedReceipt(command, { code: "invalid_input", message }, { exitCode: 2 })

export const progressWriter = (
  dependencies: CliDependencies,
  output: CliOutputFormat
): ((identity: ReceiptIdentity, event: HeadlessRunEvent) => void) => {
  const lineOf = progressLines()
  return (identity, event) => {
    if (output === CLI_OUTPUT_FORMAT.jsonl) {
      dependencies.writeStderr(
        `${JSON.stringify({
          version: 1,
          type: "run_event",
          run_id: identity.runId,
          session_id: identity.sessionId,
          event: event.data
        })}\n`
      )
      return
    }
    const line = output === CLI_OUTPUT_FORMAT.text ? lineOf(event) : undefined
    if (line !== undefined) dependencies.writeStderr(`arden: ${line}\n`)
  }
}

export const writeReceipt = (
  dependencies: CliDependencies,
  output: CliOutputFormat,
  receipt: CommandReceiptV1
): number => {
  if (output !== CLI_OUTPUT_FORMAT.text) {
    dependencies.writeStdout(`${JSON.stringify(receipt)}\n`)
    return receipt.exit_code
  }
  if (receipt.status === RECEIPT_STATUS.submitted && receipt.run_id !== null) {
    dependencies.writeStdout(`${receipt.run_id}\n`)
    dependencies.writeStderr(
      `arden: the Run goes on in Arden; follow it with: arden wait ${receipt.run_id}\n`
    )
  } else if (receipt.status === RECEIPT_STATUS.completed && receipt.result !== null) {
    const text = receipt.result.text
    if (text.length > 0) dependencies.writeStdout(text.endsWith("\n") ? text : `${text}\n`)
  } else if (receipt.error !== null) {
    dependencies.writeStderr(`arden: ${receipt.error.message}\n`)
  }
  return receipt.exit_code
}
