import type { OperationalEvent } from "@arden-hq/protocol/daemon"
import { redactedFailureText } from "@arden-hq/std/errors"
import { Cause } from "effect"

type Occurrence = "version" | "occurredAt"

export type OperationalEventInput = OperationalEvent extends infer Event
  ? Event extends OperationalEvent
    ? Omit<Event, Occurrence>
    : never
  : never

export const serializeOperationalCause = (cause: unknown): string | null => {
  if (cause === undefined || cause === null) return null
  let rendered: string
  if (Cause.isCause(cause)) rendered = Cause.pretty(cause)
  else if (cause instanceof Error) rendered = `${cause.name}: ${cause.message}`
  else rendered = String(cause)
  const normalized = redactedFailureText(rendered)
  return normalized.length === 0 ? "Unknown failure" : normalized
}

export const operationalCauseText = (cause: unknown): string =>
  serializeOperationalCause(cause) ?? "Unknown failure"

export const operationalEvent = (
  input: OperationalEventInput,
  occurredAt: string
): OperationalEvent =>
  ("cause" in input
    ? { ...input, cause: operationalCauseText(input.cause), version: 1, occurredAt }
    : { ...input, version: 1, occurredAt }) as OperationalEvent
