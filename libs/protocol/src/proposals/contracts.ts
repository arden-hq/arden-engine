import type {
  SpaceTask,
  SpaceTaskCaptureInput,
  SpaceTaskOwner,
  SpaceTaskSource
} from "../spaces/work/contracts.js"
import type { JsonRecord } from "../common/json.js"

export type TaskProposalPlace = "space" | "chat"

export type TaskProposalSignalSender =
  | { readonly kind: "unnamed" }
  | { readonly kind: "named"; readonly name: string }

export type TaskProposalRetirementEvidence =
  | {
      readonly kind: "chat"
      readonly session_id: string
      readonly turn:
        | { readonly kind: "whole_chat" }
        | { readonly kind: "turn"; readonly turn_id: string }
      readonly label: TaskProposalSignalSender
    }
  | { readonly kind: "memory"; readonly page_ref: string }
  | { readonly kind: "task"; readonly item_id: string; readonly label: string }
  | {
      readonly kind: "connection_item"
      readonly item_id: string
      readonly label: string
      readonly link:
        | { readonly kind: "unlinked" }
        | { readonly kind: "linked"; readonly url: string }
    }

export interface TaskProposalRetirement extends JsonRecord {
  readonly reason: string
  readonly evidence: ReadonlyArray<TaskProposalRetirementEvidence>
}

export const TASK_PROPOSAL_PLACEMENT = { space: "space", chat: "chat" } as const

export type TaskProposalPlacement =
  | { readonly kind: "space"; readonly space_id: string }
  | { readonly kind: "chat"; readonly session_id: string }

export type TaskProposalBody =
  | { readonly kind: "plain" }
  | { readonly kind: "detailed"; readonly text: string }

export type TaskProposalSignal =
  | { readonly kind: "unsignalled" }
  | {
      readonly kind: "signal"
      readonly source: string
      readonly title: string
      readonly from: TaskProposalSignalSender
    }

export const TASK_PROPOSAL_ORIGIN = { router: "router", run: "run" } as const

export type TaskProposalOrigin =
  | { readonly kind: "router" }
  | {
      readonly kind: "run"
      readonly run_id: string
      readonly session_id: string
      readonly turn_id: string
      readonly tool_call_id: string
    }

export type TaskProposalPutOff =
  | { readonly kind: "in_view" }
  | { readonly kind: "put_off"; readonly until: string }

export const TASK_PROPOSAL_TASK = { kept: "kept", gone: "gone" } as const

export type TaskProposalStartedTask =
  | { readonly kind: "kept"; readonly item_id: string }
  | { readonly kind: "gone" }

export type TaskProposalState =
  | { readonly status: "held" }
  | { readonly status: "offered"; readonly put_off: TaskProposalPutOff }
  | {
      readonly status: "accepted"
      readonly settled_at: string
      readonly task: TaskProposalStartedTask
    }
  | { readonly status: "rejected" | "expired"; readonly settled_at: string }
  | {
      readonly status: "retired"
      readonly settled_at: string
      readonly retirement: TaskProposalRetirement
    }

export type TaskProposalStatus = TaskProposalState["status"]

export interface TaskProposalFields extends JsonRecord {
  readonly proposal_id: string
  readonly placement: TaskProposalPlacement
  readonly stable_key: string
  readonly text: string
  readonly body: TaskProposalBody
  readonly owner: SpaceTaskOwner
  readonly capture: SpaceTaskCaptureInput
  readonly sources: ReadonlyArray<SpaceTaskSource>
  readonly signal: TaskProposalSignal
  readonly origin: TaskProposalOrigin
  readonly revision: number
  readonly created_at: string
  readonly updated_at: string
}

export type TaskProposal = TaskProposalFields & TaskProposalState

export interface TaskProposalList extends JsonRecord {
  readonly proposals: ReadonlyArray<TaskProposal>
}

export type TaskProposalScope =
  | { readonly place: "space"; readonly spaceId: string }
  | { readonly place: "chat"; readonly sessionId: string }

interface ResolveTaskProposalBase {
  readonly expected_revision: number
  readonly client_id: string
}

export const TASK_PROPOSAL_START_SPACE = { proposed: "proposed", chosen: "chosen" } as const
export const TASK_PROPOSAL_ACCEPTED_IN = { elsewhere: "elsewhere", chat: "chat" } as const

export type TaskProposalStartSpace =
  | { readonly kind: "proposed" }
  | { readonly kind: "chosen"; readonly space_id: string }

export type TaskProposalAcceptedIn =
  | { readonly kind: "elsewhere" }
  | { readonly kind: "chat"; readonly session_id: string }

export type ResolveTaskProposalInput =
  | (ResolveTaskProposalBase & {
      readonly decision: "accept"
      readonly space: TaskProposalStartSpace
      readonly accepted_in: TaskProposalAcceptedIn
    })
  | (ResolveTaskProposalBase & { readonly decision: "reject" })
  | (ResolveTaskProposalBase & { readonly decision: "later" })

export type ResolveTaskProposalTask =
  | { readonly kind: "started"; readonly task: SpaceTask }
  | { readonly kind: "unstarted" }

export interface ResolveTaskProposalResponse extends JsonRecord {
  readonly proposal: TaskProposal
  readonly task: ResolveTaskProposalTask
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

export interface TaskProposalReview {
  readonly expected_revision: number
  readonly state: "queued" | "running" | "completed" | "failed"
  readonly message: string
  readonly proposal: TaskProposal
}

export type TaskProposalReviewStatus = { readonly state: "unrequested" } | TaskProposalReview

export interface RecheckTaskProposalInput {
  readonly expected_revision: number
}
