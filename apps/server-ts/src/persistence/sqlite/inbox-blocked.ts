import { INBOX_SPACE, type InboxSpace } from "@arden-hq/protocol/inbox"
import type { InboxBlockedTaskEntry, InboxEntry, InboxEntryGroup } from "../inbox/store.js"
import { later, unread } from "./inbox-failures.js"

export interface TaskRow {
  readonly item_id: string
  readonly space_id: string | null
  readonly stable_key: string
  readonly seq: number | null
  readonly text: string
  readonly waiting_on: string
  readonly updated_at: string
}

export interface CommentRow {
  readonly item_id: string
  readonly body: string
  readonly created_at: string
}

export const group = (
  key: string,
  title: string,
  items: ReadonlyArray<InboxEntry>,
  place:
    | { readonly kind: "space"; readonly space: InboxSpace }
    | { readonly kind: Exclude<InboxEntryGroup["kind"], "space"> }
): InboxEntryGroup => ({
  ...place,
  key,
  title,
  count: items.filter((item) => item.counted).length,
  items
})

export const blockedTaskEntries = (
  tasks: ReadonlyArray<TaskRow & { readonly waiting_on: InboxBlockedTaskEntry["waitingOn"] }>,
  latestComments: ReadonlyMap<string, CommentRow>,
  spaceTitles: ReadonlyMap<string, string>,
  marks: ReadonlyMap<string, string>
): Array<InboxBlockedTaskEntry> =>
  tasks.map((task) => {
    const comment = latestComments.get(task.item_id)
    const at = later(task.updated_at, comment?.created_at ?? null)
    const key = `task:${task.item_id}`
    return {
      source: "blocked_task",
      key,
      groupKey: `space:${task.space_id ?? "none"}`,
      at,
      counted: false,
      unread: unread(at, marks.get(key)),
      readAt: marks.get(key),
      space:
        task.space_id === null
          ? { kind: INBOX_SPACE.loose }
          : {
              kind: INBOX_SPACE.space,
              space_id: task.space_id,
              title: spaceTitles.get(task.space_id) ?? ""
            },
      itemId: task.item_id,
      stableKey: task.stable_key,
      numbering: task.seq === null ? { kind: "unnumbered" } : { kind: "numbered", seq: task.seq },
      text: task.text,
      waitingOn: task.waiting_on,
      ask:
        comment === undefined
          ? { kind: "unasked" }
          : { kind: "asked", text: comment.body, at: comment.created_at }
    }
  })

export const blockedSpaceGroups = (
  shown: ReadonlyArray<InboxBlockedTaskEntry>
): Array<InboxEntryGroup> => {
  const bySpace = new Map<
    string,
    { readonly space: InboxSpace; readonly items: Array<InboxBlockedTaskEntry> }
  >()
  for (const item of shown) {
    const items = bySpace.get(item.groupKey)?.items ?? []
    items.push(item)
    bySpace.set(item.groupKey, { space: item.space, items })
  }
  return [...bySpace.entries()].map(([key, { space, items }]) =>
    group(key, space.kind === INBOX_SPACE.loose ? "No Space" : space.title, items, {
      kind: "space",
      space
    })
  )
}
