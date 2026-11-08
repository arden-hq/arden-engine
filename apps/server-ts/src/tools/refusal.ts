import { ToolExecutionError } from "@arden-hq/loop"
import { Predicate } from "effect"
import { breakerNote, renderRefusal, type Refusal } from "../execution/refusal.js"

export const refusalError = (refusal: Refusal): ToolExecutionError =>
  new ToolExecutionError(renderRefusal(refusal), {
    preview: "Not allowed here",
    retryable: false,
    host: { refusal: { rule: refusal.rule } }
  })

export const withBreaker = (error: ToolExecutionError, earlier: number): ToolExecutionError => {
  const note = breakerNote(earlier)
  if (note === "") return error
  return new ToolExecutionError(`${error.message}${note}`, {
    ...(error.preview === undefined ? {} : { preview: error.preview }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.diagnosticRef === undefined ? {} : { diagnosticRef: error.diagnosticRef }),
    ...(error.host === undefined ? {} : { host: error.host })
  })
}

export const isRefusal = (cause: unknown): cause is ToolExecutionError =>
  cause instanceof ToolExecutionError && Predicate.isReadonlyObject(cause.host?.["refusal"])
