import { ladderDelayMs } from "@arden-hq/std/retry"

export const JOB_RETRY_LADDER_MS: ReadonlyArray<number> = [60_000, 5 * 60_000]
export const TASK_RETRY_LADDER_MS: ReadonlyArray<number> = [2 * 60_000, 10 * 60_000, 30 * 60_000]
export const SPACE_REVIEW_LADDER_MS: ReadonlyArray<number> = [10 * 60_000, 30 * 60_000]
export const TASK_STILL_LADDER_MS: ReadonlyArray<number> = [15 * 60_000, 60 * 60_000]

export const ladderStepMs = (ladder: ReadonlyArray<number>, retry: number): number | undefined =>
  retry >= 1 && retry <= ladder.length ? ladderDelayMs(ladder, retry) : undefined
