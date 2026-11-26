import { TASK_PROPOSAL_STATUS } from "@arden-hq/protocol/proposals"
import { TaskSourceRecordSchema } from "../work/task-record.js"
import { Effect } from "effect"
import { TaskProposalStoreError } from "../proposals/store.js"
import { sourceIdentity, sourceRevision } from "./proposal-evidence.js"

export interface ProposalRow {
  readonly proposal_id: string
  readonly place: "space" | "chat"
  readonly space_id: string | null
  readonly chat_session_id: string | null
  readonly dedupe_key: string
  readonly stable_key: string
  readonly text: string
  readonly body: string | null
  readonly owner: "worker" | "user" | "external"
  readonly capture_json: string
  readonly sources_json: string
  readonly signal_json: string | null
  readonly evidence_revision_key: string
  readonly candidate_hash: string
  readonly source_run_id: string | null
  readonly source_session_id: string | null
  readonly source_turn_id: string | null
  readonly source_tool_call_id: string | null
  readonly capture_policy_json: string | null
  readonly revision: number
  readonly seq: number
  readonly status: "held" | "offered" | "accepted" | "rejected" | "expired" | "retired"
  readonly retirement_json: string | null
  readonly item_id: string | null
  readonly settlement_client_id: string | null
  readonly settlement_decision: string | null
  readonly settlement_task_json: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly settled_at: string | null
  readonly put_off_until: string | null
  readonly waiting_since: string | null
}

export const failure = (
  reason: TaskProposalStoreError["reason"],
  message: string,
  cause?: unknown
): TaskProposalStoreError =>
  new TaskProposalStoreError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const canonicalizeSources = (
  sources: ReadonlyArray<typeof TaskSourceRecordSchema.Type>
): Effect.Effect<ReadonlyArray<typeof TaskSourceRecordSchema.Type>, TaskProposalStoreError> => {
  const byIdentity = new Map<string, typeof TaskSourceRecordSchema.Type>()
  for (const source of sources) {
    const identity = sourceIdentity(source)
    const prior = byIdentity.get(identity)
    if (prior !== undefined && sourceRevision(prior) !== sourceRevision(source)) {
      return Effect.fail(
        failure("invalid", "Task proposal evidence contains conflicting revisions for one source")
      )
    }
    byIdentity.set(identity, source)
  }
  return Effect.succeed(
    [...byIdentity.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, source]) => source)
  )
}

export const decided = (status: string): boolean =>
  status === TASK_PROPOSAL_STATUS.accepted || status === TASK_PROPOSAL_STATUS.rejected
