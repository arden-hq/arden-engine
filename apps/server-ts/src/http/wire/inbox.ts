import type { InboxGroup, InboxItem, InboxView } from "@arden-hq/protocol/inbox"
import type { InboxEntry, InboxEntryGroup, InboxState } from "../../persistence/inbox/store.js"

const entryToWire = (entry: InboxEntry): InboxItem => {
  const base = {
    key: entry.key,
    group_key: entry.groupKey,
    at: entry.at,
    counted: entry.counted,
    unread: entry.unread,
    read_mark:
      entry.readAt === undefined
        ? { kind: "unmarked" as const }
        : { kind: "marked" as const, read_at: entry.readAt }
  }
  switch (entry.source) {
    case "blocked_task":
      return {
        ...base,
        source: entry.source,
        space: entry.space,
        item_id: entry.itemId,
        stable_key: entry.stableKey,
        numbering: entry.numbering,
        text: entry.text,
        waiting_on: entry.waitingOn,
        ask: entry.ask
      }
    case "approval":
      return { ...entry.approval, ...base, source: entry.source }
    case "failure":
      return {
        ...base,
        source: entry.source,
        space: entry.space,
        origin: entry.origin,
        cause: entry.cause,
        run_count: entry.runCount,
        first_at: entry.firstAt,
        last_at: entry.lastAt,
        automation_paused: entry.automationPaused
      }
    case "question":
      return { ...base, source: entry.source, question: entry.question }
    case "incident":
      return {
        ...base,
        source: entry.source,
        incident_id: entry.incidentId,
        code: entry.code,
        summary: entry.summary,
        delivery_id: entry.deliveryId,
        source_run_id: entry.sourceRunId
      }
    case "plan_limit":
      return {
        ...base,
        source: entry.source,
        reached: entry.reached,
        used_percent: entry.usedPercent,
        window_seconds: entry.windowSeconds,
        resets_at: entry.resetsAt
      }
  }
}

const groupToWire = (group: InboxEntryGroup): InboxGroup => ({
  ...group,
  items: group.items.map(entryToWire)
})

export const inboxToWire = (inbox: InboxState): InboxView => ({
  generated_at: inbox.generatedAt,
  count: inbox.count,
  unread_count: inbox.unreadCount,
  total_items: inbox.totalItems,
  truncated: inbox.truncated,
  groups: inbox.groups.map(groupToWire)
})
