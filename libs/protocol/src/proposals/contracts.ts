import type {
  SpaceTask,
  SpaceTaskCaptureInput,
  SpaceTaskOwner,
  SpaceTaskSource
} from "../spaces/work/contracts.js"
import type { JsonRecord } from "../common/json.js"

/** Where a suggestion waits: a Space's conversation, a chat, or Home. */
export type TaskProposalPlace = "space" | "chat" | "home"

export interface TaskProposalCapturePolicy extends JsonRecord {
  readonly origin: "chat" | "automation" | "task" | "space" | "unrecorded"
  readonly task_item_id: string | null
  readonly task_generation: number | null
}

/** The outside item a suggestion came from, kept after the item expires.
 *  `source` is a signal source id (`@arden-hq/protocol/signals`). */
export interface TaskProposalSignal extends JsonRecord {
  readonly source: string
  readonly title: string
  readonly from: string | null
}

/** A record a review cited as proof that an offer's outcome is done, named for the person.
 *  A label is null when the record is gone or never had a name. */
export type TaskProposalRetirementEvidence =
  | {
      readonly kind: "chat"
      readonly session_id: string
      readonly turn_id: string | null
      readonly label: string | null
    }
  | { readonly kind: "memory"; readonly page_ref: string }
  | { readonly kind: "task"; readonly item_id: string; readonly label: string }
  | {
      readonly kind: "connection_item"
      readonly item_id: string
      readonly label: string
      /** The item's web page; null for a mail, which has none of its own. */
      readonly url: string | null
    }

/** Why a review closed an offer as done, and what it cited. */
export interface TaskProposalRetirement extends JsonRecord {
  readonly reason: string
  readonly evidence: ReadonlyArray<TaskProposalRetirementEvidence>
}

/**
 * A Task Arden suggests and the person starts or skips (goal-task-merge §12):
 * a run's proposal on its Space, or the item router's on Home. `held` waits
 * behind the five open on Home. Start creates the Task from the stored words;
 * Skip is durable for its evidence and for a cited thread.
 */
export interface TaskProposal extends JsonRecord {
  readonly proposal_id: string
  readonly place: TaskProposalPlace
  /** The Space it waits on (place `space`). */
  readonly space_id: string | null
  /** The chat it waits in (place `chat`). */
  readonly chat_session_id: string | null
  readonly stable_key: string
  readonly text: string
  readonly body: string | null
  readonly owner: SpaceTaskOwner
  /** `reason` says why it was suggested. */
  readonly capture: SpaceTaskCaptureInput
  readonly sources: ReadonlyArray<SpaceTaskSource>
  readonly signal: TaskProposalSignal | null
  /** The run, turn and tool call that proposed it; all null for the item router's. */
  readonly source_run_id: string | null
  readonly source_session_id: string | null
  readonly source_turn_id: string | null
  readonly source_tool_call_id: string | null
  readonly capture_policy: TaskProposalCapturePolicy | null
  readonly revision: number
  readonly status: "held" | "offered" | "accepted" | "rejected" | "retired"
  /** Set exactly when `status` is `retired`. */
  readonly retirement: TaskProposalRetirement | null
  /** The Task Start created; null before, or once that Task is gone. */
  readonly item_id: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly settled_at: string | null
}

export interface TaskProposalList extends JsonRecord {
  readonly proposals: ReadonlyArray<TaskProposal>
}

/** Which suggestions to list: one Space's, one chat's, or Home's. */
export type TaskProposalScope =
  | { readonly place: "space"; readonly spaceId: string }
  | { readonly place: "chat"; readonly sessionId: string }
  | { readonly place: "home" }

export interface ResolveTaskProposalInput {
  readonly expected_revision: number
  readonly client_id: string
  readonly decision: "accept" | "reject"
  /** The chat it was accepted in, which then hears how the Task goes. */
  readonly session_id?: string
  /** The Space Start puts the Task on: required on Home; a Space's own proposal
   *  goes on that Space. */
  readonly space_id?: string
}

export interface ResolveTaskProposalResponse extends JsonRecord {
  readonly proposal: TaskProposal
  /** The Task Start created; null for a Skip, or a Start whose Task is gone. */
  readonly task: SpaceTask | null
}

/** Exact applied action evidence is available only when retiring a suggestion. */
export interface ChatActionRetirementSource {
  readonly kind: "chat_action"
  readonly session_id: string
  readonly turn_id: string
  readonly run_id: string
  readonly tool_call_id: string
  readonly revision: string
}

export type TaskProposalRetirementSource = SpaceTaskSource | ChatActionRetirementSource

/** Why the server could not settle an offered suggestion. */
export type TaskProposalConflictKind =
  | "proposal_changed"
  | "source_changed"
  | "source_unavailable"
  | "space_unavailable"
  | "settled"
  | "not_offered"

export interface TaskProposalConflict {
  readonly kind: TaskProposalConflictKind
  readonly message: string
}

/** The latest explicit recheck, projected from the existing Space review queue/run. */
export interface TaskProposalReview {
  readonly expected_revision: number
  readonly state: "queued" | "running" | "completed" | "failed"
  readonly message: string
  readonly proposal: TaskProposal
}

export interface RecheckTaskProposalInput {
  readonly expected_revision: number
}
