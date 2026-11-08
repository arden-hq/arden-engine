import type { InboxGroup, InboxItem, InboxView } from "@arden-hq/protocol/inbox"
import type { InboxEntry, InboxEntryGroup, InboxState } from "../../persistence/inbox/store.js"

const entryToWire = (entry: InboxEntry): InboxItem => {
  const base = {
    key: entry.key,
    group_key: entry.groupKey,
    at: entry.at,
    counted: entry.counted,
    unread: entry.unread,
    read_at: entry.readAt ?? null
  }
  switch (entry.source) {
    case "blocked_task":
      return {
        ...base,
        source: entry.source,
        space_id: entry.spaceId,
        space_title: entry.spaceTitle,
        item_id: entry.itemId,
        stable_key: entry.stableKey,
        seq: entry.seq ?? null,
        text: entry.text,
        waiting_on: entry.waitingOn,
        question: entry.question ?? null,
        question_at: entry.questionAt ?? null
      }
    case "approval":
      return { ...entry.approval, ...base, source: entry.source }
    case "failure":
      return {
        ...base,
        source: entry.source,
        space_id: entry.spaceId ?? null,
        space_title: entry.spaceTitle ?? null,
        automation_task_id: entry.automationTaskId ?? null,
        run_id: entry.runId ?? null,
        workflow_ref: entry.workflowRef ?? null,
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
        level: entry.level,
        used_percent: entry.usedPercent,
        limit_percent: entry.limitPercent ?? null,
        window_seconds: entry.windowSeconds,
        resets_at: entry.resetsAt
      }
  }
}

const groupToWire = (group: InboxEntryGroup): InboxGroup => ({
  key: group.key,
  kind: group.kind,
  title: group.title,
  space_id: group.spaceId ?? null,
  count: group.count,
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
