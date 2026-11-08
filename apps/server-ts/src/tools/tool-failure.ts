import { ToolExecutionError } from "@arden-hq/loop"

const RETRYABLE = {
  conflict: true,
  unavailable: true,
  storage: true,
  closed: true,
  invalid: false,
  not_found: false,
  corrupt: false,
  blocked: false,
  quota: false,
  unsafe_retry: false,
  auth_required: false,
  not_set_up: false,
  rejected: false,
  terminal: false,
  access_denied: false,
  invalid_response: false,
  not_configured: false,
  provider: true,
  invalid_output: false
} as const satisfies Record<string, boolean>

type FailureReason = keyof typeof RETRYABLE

const retryableReason = (reason: FailureReason): boolean => RETRYABLE[reason]

export const toolFailure = (
  error: { readonly reason: FailureReason; readonly message: string },
  preview: string
): ToolExecutionError => {
  const retryable = retryableReason(error.reason)
  return new ToolExecutionError(error.message, { preview, retryable })
}

export const toolFault = (message: string, preview: string): ToolExecutionError =>
  new ToolExecutionError(message, { preview, retryable: true })

export const toolRefusal = (message: string, preview: string): ToolExecutionError =>
  new ToolExecutionError(message, { preview, retryable: false })
