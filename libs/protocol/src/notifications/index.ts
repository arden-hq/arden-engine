import type { RecordToldEvent, RecordToldStatus } from "../events/contracts.js"

/**
 * When to notify the owner: one rule over the records the server keeps, shared by
 * the desktop's native notifications and the phone's pushes. Notify is a
 * projection of those records, never a writer and never a re-derivation:
 *
 * - `ending`: a run's ending (`run_endings`), keyed by the run.
 * - `entity`: a Task or an Automation telling about itself (`entity_events`).
 * - `ask`: something that waits on the owner (a question, an approval, an Inbox
 *   item), keyed by its own record.
 *
 * `shown` is whether the owner sees the record somewhere: a row in a chat, the
 * run's own reply, or an Inbox item. A record only the chat's model is told never
 * notifies.
 */
export type NoticeRecord =
  | {
      readonly kind: "ending"
      readonly key: string
      readonly status: RecordToldStatus
      readonly shown: boolean
      /** The chat it was told in holds something the owner has not read. */
      readonly unread: boolean
    }
  | {
      readonly kind: "entity"
      readonly key: string
      readonly status: RecordToldStatus
      readonly shown: boolean
      /** The chat it was told in holds something the owner has not read. */
      readonly unread: boolean
    }
  | { readonly kind: "ask"; readonly key: string }

export type NotificationLevel = "off" | "needs_you" | "everything"

/** Which level a notice needs: what waits on the owner, or what finished. */
export type NoticeTier = "needs_you" | "everything"

/** The tier a record belongs to; undefined for one that is never news. */
export const noticeTier = (record: NoticeRecord): NoticeTier | undefined => {
  if (record.kind === "ask") return "needs_you"
  if (!record.shown) return undefined
  switch (record.status) {
    case "finished":
    case "done":
      return "everything"
    case "blocked":
    case "failed":
    case "paused":
      return "needs_you"
    case "cancelled":
    case "silent":
    case "waiting":
      return undefined
  }
}

/**
 * Whether this record is news to the owner now: it has a tier, the owner's level
 * lets that tier through, and Arden is not in front (it shows all of this itself).
 */
export const notifyOwner = (input: {
  readonly record: NoticeRecord
  readonly level: NotificationLevel
  readonly inFront: boolean
}): boolean => {
  if (input.inFront) return false
  const tier = noticeTier(input.record)
  if (tier === undefined) return false
  if (tier === "everything" && input.record.kind !== "ask" && !input.record.unread) return false
  switch (input.level) {
    case "off":
      return false
    case "needs_you":
      return tier === "needs_you"
    case "everything":
      return true
  }
}

/** The record a `record_told` event carries. */
export const noticeOfEvent = (event: RecordToldEvent): NoticeRecord => ({
  kind: event.record,
  key: event.key,
  status: event.status,
  shown: event.shown,
  unread: event.unread
})

/**
 * The keys already notified, so a record notifies at most once however often it
 * is seen again (a replay, a reconnect, a view that lists it again). Bounded: the
 * oldest keys are forgotten first.
 */
export interface NoticeLedger {
  /** True the first time a key is taken, false after. */
  readonly take: (key: string) => boolean
}

export const noticeLedger = (limit = 500): NoticeLedger => {
  const taken = new Set<string>()
  return {
    take: (key) => {
      if (taken.has(key)) return false
      taken.add(key)
      for (const old of taken) {
        if (taken.size <= limit) break
        taken.delete(old)
      }
      return true
    }
  }
}
