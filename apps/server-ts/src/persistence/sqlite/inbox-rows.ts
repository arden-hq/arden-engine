import { quoted } from "@arden-hq/std/count"
import { INBOX_ITEM_LIMIT } from "@arden-hq/protocol/inbox"
import { type CommentRow, type TaskRow } from "./inbox-blocked.js"
import { Effect } from "effect"
import {
  InboxStoreError,
  type InboxEntryGroup,
  type InboxState,
  type OpenAsks
} from "../inbox/store.js"
import type { RunApproval } from "@arden-hq/protocol/runs"
import {
  collapseWhitespace,
  failureCause,
  timeValue,
  type SpacePauseRow,
  type FailureRow,
  type PauseRow
} from "./inbox-failures.js"

export const FAILURE_WINDOW_DAYS = 7

export interface SpaceRow {
  readonly space_id: string
  readonly name: string
}

export interface AbandonedDeliveryRow {
  readonly workflow_ref: string
  readonly attempt: number
  readonly origin_run_id: string
  readonly space_id: string | null
  readonly chat_name: string | null
  readonly last_error: string | null
  readonly settled_at: string
}

export interface IncidentRow {
  readonly incident_id: string
  readonly delivery_id: string
  readonly code: "delivery.unroutable"
  readonly summary: string
  readonly source_run_id: string
  readonly created_at: string
}

export interface ReadRow {
  readonly item_key: string
  readonly read_at: string
}

export interface DismissRow {
  readonly item_key: string
  readonly dismissed_at: string
}

export interface Snapshot {
  readonly questions: OpenAsks["questions"]
  readonly now: string
  readonly spaces: ReadonlyArray<SpaceRow>
  readonly tasks: ReadonlyArray<TaskRow>
  readonly comments: ReadonlyArray<CommentRow>
  readonly approvals: ReadonlyArray<RunApproval>
  readonly failures: ReadonlyArray<FailureRow>
  readonly pauses: ReadonlyArray<PauseRow>
  readonly spacePauses: ReadonlyArray<SpacePauseRow>
  readonly abandonedDeliveries: ReadonlyArray<AbandonedDeliveryRow>
  readonly incidents: ReadonlyArray<IncidentRow>
  readonly marks: ReadonlyArray<ReadRow>
  readonly dismissals: ReadonlyArray<DismissRow>
  readonly planLimitNotice: string | undefined
}

export type StoreOperation = "view" | "mark_read" | "dismiss"
export type OpenAsksOperation = StoreOperation | "open_asks"

export interface Projection {
  readonly view: InboxState
  readonly live: ReadonlyArray<{ readonly key: string; readonly groupKey: string }>
}

export const storeError = (
  operation: OpenAsksOperation,
  reason: "invalid" | "not_found" | "storage",
  message: string,
  cause?: unknown
): InboxStoreError =>
  new InboxStoreError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const abandonedDeliveryCause = (row: AbandonedDeliveryRow): string => {
  const chat =
    row.chat_name === null || collapseWhitespace(row.chat_name).length === 0
      ? "its chat"
      : quoted(row.chat_name)
  const reason = row.last_error === null ? "no error was recorded" : failureCause(row.last_error)
  return `Workflow result never reached ${chat}: ${reason}`
}

export const byRecency = <T extends { readonly at: string; readonly key: string }>(
  items: ReadonlyArray<T>
): Array<T> =>
  [...items].sort((left, right) => {
    const difference = timeValue(right.at) - timeValue(left.at)
    return difference === 0 || Number.isNaN(difference)
      ? right.key.localeCompare(left.key)
      : difference
  })

export const newestFirst = <T>(
  items: ReadonlyArray<T>,
  at: (item: T) => string,
  key: (item: T) => string
): Array<T> =>
  byRecency(items.map((item) => ({ item, at: at(item), key: key(item) }))).map(({ item }) => item)

export const approvalKey = (approval: RunApproval): string =>
  `approval:${approval.run_id}:${approval.tool_call_id}`

export const capGroups = (groups: ReadonlyArray<InboxEntryGroup>): Array<InboxEntryGroup> => {
  const result: Array<InboxEntryGroup> = []
  let remaining = INBOX_ITEM_LIMIT
  for (const current of groups) {
    if (remaining <= 0) break
    const items = current.items.slice(0, remaining)
    remaining -= items.length
    result.push({ ...current, items, count: items.filter((item) => item.counted).length })
  }
  return result
}

export const query = <A>(
  operation: OpenAsksOperation,
  statement: Effect.Effect<ReadonlyArray<A>, unknown>
): Effect.Effect<ReadonlyArray<A>, InboxStoreError> =>
  statement.pipe(
    Effect.mapError((cause) => storeError(operation, "storage", "Could not read Inbox data", cause))
  )
