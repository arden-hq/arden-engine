import type { ChatActionRetirementSource } from "@arden-hq/protocol/proposals"

export interface SessionToolEvidenceInput {
  readonly sessionId: string
  readonly turnId?: string
  readonly limit: number
  readonly before?: number
  readonly contentOffset?: number
  readonly contentChars?: number
}

interface SessionToolEvidence {
  readonly cursor: number
  readonly turn_id: string | null
  readonly tool_call_id: string
  readonly tool_name: string
  readonly status: string
  readonly changes_state: boolean
  readonly source: ChatActionRetirementSource | undefined
  readonly payload: {
    readonly text: string
    readonly total_chars: number
    readonly next_offset: number | undefined
  }
}

export interface SessionToolEvidencePage {
  readonly items: ReadonlyArray<SessionToolEvidence>
  readonly next_before: number | undefined
}
