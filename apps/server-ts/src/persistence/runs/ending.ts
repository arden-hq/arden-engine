import { Schema } from "effect"
import { JOB_PURPOSE } from "../job-classification.js"

export const PLACE_KIND = {
  own: "own",
  chat: "chat",
  parent: "parent",
  sender: "sender",
  gone: "gone"
} as const

export type PlaceKind = (typeof PLACE_KIND)[keyof typeof PLACE_KIND]

export const PlaceKindSchema = Schema.Literals(Object.values(PLACE_KIND))

export const ENDING_PURPOSE = { chat: "chat", ...JOB_PURPOSE } as const

export type EndingPurpose = (typeof ENDING_PURPOSE)[keyof typeof ENDING_PURPOSE]

export const EndingPurposeSchema = Schema.Literals(Object.values(ENDING_PURPOSE))

export const ENDING_STATUS = {
  finished: "finished",
  blocked: "blocked",
  failed: "failed",
  cancelled: "cancelled",
  silent: "silent",
  waiting: "waiting"
} as const

export type EndingStatus = (typeof ENDING_STATUS)[keyof typeof ENDING_STATUS]

export const EndingStatusSchema = Schema.Literals(Object.values(ENDING_STATUS))

export const ENDING_DETAIL = {
  empty: "empty",
  noChange: "no_change",
  needsYou: "needs_you",
  step: "step",
  damaged: "damaged"
} as const

export type EndingDetail = (typeof ENDING_DETAIL)[keyof typeof ENDING_DETAIL]

export interface EndingRecord {
  readonly runId: string
  readonly purpose: EndingPurpose
  readonly status: EndingStatus
  readonly detail: string | null
  readonly text: string
  readonly place: string | null
  readonly placeKind: PlaceKind
  readonly occurredAt: string
  readonly shown: boolean
  readonly decided: boolean
}
