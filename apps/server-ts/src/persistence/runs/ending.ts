export type PlaceKind = "own" | "chat" | "parent" | "sender" | "gone"

export type Purpose = "chat" | "user_automation" | "system" | "task_execution" | "space_review"

export type EndingStatus = "finished" | "blocked" | "failed" | "cancelled" | "silent" | "waiting"

export interface EndingRecord {
  readonly runId: string
  readonly purpose: Purpose
  readonly status: EndingStatus
  readonly detail: string | null
  readonly text: string
  readonly place: string | null
  readonly placeKind: PlaceKind
  readonly occurredAt: string
  readonly shown: boolean
  readonly decided: boolean
}
