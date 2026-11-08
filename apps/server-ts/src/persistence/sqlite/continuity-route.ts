import type { CommunicationDoor } from "@arden-hq/protocol/chat"
import type { RunContext } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { CommunicationStoreError } from "../continuity/store.js"

export interface SourceRunRow {
  readonly run_id: string
  readonly session_id: string
  readonly source_ref: string
  readonly source_name: string | null
  readonly status: string
  readonly context_json: string
}

export const communicationError = (
  reason: "invalid" | "not_found" | "conflict" | "storage",
  message: string,
  cause?: unknown
): CommunicationStoreError =>
  new CommunicationStoreError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const canonicalHref = (prefix: string, value: string): string =>
  `${prefix}${encodeURIComponent(value)}`

export const runDoor = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  label: string,
  source: SourceRunRow,
  context: RunContext
) {
  const href = canonicalHref("arden:session/", source.source_ref)
  const owner = context.belongs_to ?? context.origin
  const automationId = owner.kind === "automation" ? owner.automation_id : undefined
  const automation =
    automationId === undefined
      ? undefined
      : (yield* sql<{ readonly name: string; readonly automation_ref: string }>`
          SELECT name, automation_ref FROM scheduled_tasks
          WHERE task_id = ${automationId}`)[0]
  if (automation === undefined)
    return {
      kind: "run",
      label,
      run_id: source.run_id,
      session_ref: source.source_ref,
      href
    } satisfies CommunicationDoor
  return {
    kind: "automation_run",
    label: automation.name.trim().slice(0, 160),
    automation_ref: automation.automation_ref,
    run_id: source.run_id,
    session_ref: source.source_ref,
    href
  } satisfies CommunicationDoor
})
