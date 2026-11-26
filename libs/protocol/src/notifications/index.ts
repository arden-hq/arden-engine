import type { RecordToldEvent, RecordToldStatus } from "../events/contracts.js"

export const NOTICE_RECORD = { ending: "ending", entity: "entity", ask: "ask" } as const

export type NoticeRecord =
  | {
      readonly kind: typeof NOTICE_RECORD.ending
      readonly key: string
      readonly status: RecordToldStatus
      readonly shown: boolean
      readonly unread: boolean
    }
  | {
      readonly kind: typeof NOTICE_RECORD.entity
      readonly key: string
      readonly status: RecordToldStatus
      readonly shown: boolean
      readonly unread: boolean
    }
  | { readonly kind: typeof NOTICE_RECORD.ask; readonly key: string }

export const NOTIFICATION_LEVEL = {
  off: "off",
  needs_you: "needs_you",
  everything: "everything"
} as const

export type NotificationLevel = (typeof NOTIFICATION_LEVEL)[keyof typeof NOTIFICATION_LEVEL]

export const NOTICE_TIER = { needs_you: "needs_you", everything: "everything" } as const

export type NoticeTier = (typeof NOTICE_TIER)[keyof typeof NOTICE_TIER]

const STATUS_TIER: Record<RecordToldStatus, NoticeTier | undefined> = {
  finished: NOTICE_TIER.everything,
  done: NOTICE_TIER.everything,
  blocked: NOTICE_TIER.needs_you,
  failed: NOTICE_TIER.needs_you,
  paused: NOTICE_TIER.needs_you,
  posted: NOTICE_TIER.needs_you,
  cancelled: undefined,
  silent: undefined,
  waiting: undefined
}

export const noticeTier = (record: NoticeRecord): NoticeTier | undefined => {
  if (record.kind === NOTICE_RECORD.ask) return NOTICE_TIER.needs_you
  if (!record.shown) return undefined
  return STATUS_TIER[record.status]
}

const LEVEL_NOTIFIES: Record<NotificationLevel, (tier: NoticeTier) => boolean> = {
  off: () => false,
  needs_you: (tier) => tier === NOTICE_TIER.needs_you,
  everything: () => true
}

export const notifyOwner = (input: {
  readonly record: NoticeRecord
  readonly level: NotificationLevel
  readonly inFront: boolean
}): boolean => {
  if (input.inFront) return false
  const tier = noticeTier(input.record)
  if (tier === undefined) return false
  if (
    tier === NOTICE_TIER.everything &&
    input.record.kind !== NOTICE_RECORD.ask &&
    !input.record.unread
  )
    return false
  return LEVEL_NOTIFIES[input.level](tier)
}

export const noticeOfEvent = (event: RecordToldEvent): NoticeRecord => ({
  kind: event.record,
  key: event.key,
  status: event.status,
  shown: event.shown,
  unread: event.unread
})

export interface NoticeLedger {
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
