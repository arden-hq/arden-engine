import type { JsonRecord } from "../common/json.js"

interface CompactionOutcomeBase extends JsonRecord {
  readonly message: string
}

export interface NoSessionCompactionOutcome extends CompactionOutcomeBase {
  readonly status: "noSession"
}

export interface NothingToCompactOutcome extends CompactionOutcomeBase {
  readonly status: "nothingToCompact"
  readonly messageCount: number
  readonly inputTokens: number | null
}

export interface AlreadyOptimalCompactionOutcome extends CompactionOutcomeBase {
  readonly status: "alreadyOptimal"
  readonly messageCount: number
}

export interface CompactedContextOutcome extends CompactionOutcomeBase {
  readonly status: "compacted"
  readonly inputTokens: number | null
  readonly beforeMessageCount: number
  readonly afterMessageCount: number
  readonly messagesCompressed: number
}

export type ContextCompactionOutcome =
  | NoSessionCompactionOutcome
  | NothingToCompactOutcome
  | AlreadyOptimalCompactionOutcome
  | CompactedContextOutcome
