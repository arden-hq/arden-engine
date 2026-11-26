export const CLI_OUTPUT_FORMAT = { text: "text", json: "json", jsonl: "jsonl" } as const

export type CliOutputFormat = (typeof CLI_OUTPUT_FORMAT)[keyof typeof CLI_OUTPUT_FORMAT]

export const RECEIPT_STATUS = {
  completed: "completed",
  submitted: "submitted",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  timedOut: "timed_out"
} as const

export type ReceiptStatus = (typeof RECEIPT_STATUS)[keyof typeof RECEIPT_STATUS]
