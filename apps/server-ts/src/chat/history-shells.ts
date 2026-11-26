import {
  ACTIVE_WORK,
  PAGE_BOUNDS,
  TURN_ENDING,
  type ActiveWork,
  type HistoryPage,
  type TurnEnding,
  type TurnWorkResponse
} from "@arden-hq/protocol/chat"
import { boundActiveWorkTail } from "./history-budget.js"

export const IDLE_WORK: ActiveWork = { kind: ACTIVE_WORK.idle }

export const runningWork = (work: TurnWorkResponse): ActiveWork => ({
  kind: ACTIVE_WORK.running,
  work: boundActiveWorkTail(work)
})

export const pageBefore = (page: HistoryPage): string | undefined =>
  page.bounds.kind === PAGE_BOUNDS.bounded ? page.bounds.before : undefined

export const turnEnding = (
  failure: { readonly code: string; readonly message: string } | undefined
): TurnEnding =>
  failure === undefined
    ? { kind: TURN_ENDING.ended }
    : { kind: TURN_ENDING.failed, code: failure.code, message: failure.message }
