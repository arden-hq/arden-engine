import type {
  SpaceTask,
  SpaceTaskCaptureInput,
  SpaceTaskOwner,
  SpaceTaskSource
} from "../spaces/work/contracts.js"
import type { JsonRecord } from "../common/json.js"
import { SOURCE_KIND } from "../spaces/work/contracts.js"

export const TASK_PROPOSAL_PLACEMENT = { space: "space", chat: "chat" } as const

export type TaskProposalPlace =
  (typeof TASK_PROPOSAL_PLACEMENT)[keyof typeof TASK_PROPOSAL_PLACEMENT]

export type TaskProposalSignalSender =
  | { readonly kind: "unnamed" }
  | { readonly kind: "named"; readonly name: string }

export const TASK_PROPOSAL_RETIREMENT_EVIDENCE = {
  chat: "chat",
  memory: "memory",
  task: "task",
  connection_item: "connection_item"
} as const

export type TaskProposalRetirementEvidence =
  | {
      readonly kind: typeof TASK_PROPOSAL_RETIREMENT_EVIDENCE.chat
      readonly session_id: string
      readonly turn:
        | { readonly kind: "whole_chat" }
        | { readonly kind: "turn"; readonly turn_id: string }
      readonly label: TaskProposalSignalSender
    }
  | { readonly kind: typeof TASK_PROPOSAL_RETIREMENT_EVIDENCE.memory; readonly page_ref: string }
  | {
      readonly kind: typeof TASK_PROPOSAL_RETIREMENT_EVIDENCE.task
      readonly item_id: string
      readonly label: string
    }
  | {
      readonly kind: typeof TASK_PROPOSAL_RETIREMENT_EVIDENCE.connection_item
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

export type TaskProposalPlacement =
  | { readonly kind: typeof TASK_PROPOSAL_PLACEMENT.space; readonly space_id: string }
  | { readonly kind: typeof TASK_PROPOSAL_PLACEMENT.chat; readonly session_id: string }

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
  | { readonly kind: typeof TASK_PROPOSAL_ORIGIN.router }
  | {
      readonly kind: typeof TASK_PROPOSAL_ORIGIN.run
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
  | { readonly kind: typeof TASK_PROPOSAL_TASK.kept; readonly item_id: string }
  | { readonly kind: typeof TASK_PROPOSAL_TASK.gone }

export const TASK_PROPOSAL_STATUS = {
  held: "held",
  offered: "offered",
  accepted: "accepted",
  rejected: "rejected",
  expired: "expired",
  retired: "retired"
} as const

export type TaskProposalState =
  | { readonly status: typeof TASK_PROPOSAL_STATUS.held }
  | { readonly status: typeof TASK_PROPOSAL_STATUS.offered; readonly put_off: TaskProposalPutOff }
  | {
      readonly status: typeof TASK_PROPOSAL_STATUS.accepted
      readonly settled_at: string
      readonly task: TaskProposalStartedTask
    }
  | {
      readonly status: typeof TASK_PROPOSAL_STATUS.rejected | typeof TASK_PROPOSAL_STATUS.expired
      readonly settled_at: string
    }
  | {
      readonly status: typeof TASK_PROPOSAL_STATUS.retired
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
  | { readonly place: typeof TASK_PROPOSAL_PLACEMENT.space; readonly spaceId: string }
  | { readonly place: typeof TASK_PROPOSAL_PLACEMENT.chat; readonly sessionId: string }

interface ResolveTaskProposalBase {
  readonly expected_revision: number
  readonly client_id: string
}

export const TASK_PROPOSAL_START_SPACE = { proposed: "proposed", chosen: "chosen" } as const
export const TASK_PROPOSAL_ACCEPTED_IN = { elsewhere: "elsewhere", chat: "chat" } as const

export type TaskProposalStartSpace =
  | { readonly kind: typeof TASK_PROPOSAL_START_SPACE.proposed }
  | { readonly kind: typeof TASK_PROPOSAL_START_SPACE.chosen; readonly space_id: string }

export type TaskProposalAcceptedIn =
  | { readonly kind: typeof TASK_PROPOSAL_ACCEPTED_IN.elsewhere }
  | { readonly kind: typeof TASK_PROPOSAL_ACCEPTED_IN.chat; readonly session_id: string }

export const TASK_PROPOSAL_DECISION = {
  accept: "accept",
  reject: "reject",
  later: "later"
} as const

export type ResolveTaskProposalInput =
  | (ResolveTaskProposalBase & {
      readonly decision: typeof TASK_PROPOSAL_DECISION.accept
      readonly space: TaskProposalStartSpace
      readonly accepted_in: TaskProposalAcceptedIn
    })
  | (ResolveTaskProposalBase & { readonly decision: typeof TASK_PROPOSAL_DECISION.reject })
  | (ResolveTaskProposalBase & { readonly decision: typeof TASK_PROPOSAL_DECISION.later })

export const RESOLVED_PROPOSAL_TASK = { started: "started", unstarted: "unstarted" } as const

export type ResolveTaskProposalTask =
  | { readonly kind: typeof RESOLVED_PROPOSAL_TASK.started; readonly task: SpaceTask }
  | { readonly kind: typeof RESOLVED_PROPOSAL_TASK.unstarted }

export interface ResolveTaskProposalResponse extends JsonRecord {
  readonly proposal: TaskProposal
  readonly task: ResolveTaskProposalTask
}

export const TASK_PROPOSAL_RETIREMENT_SOURCE = {
  ...SOURCE_KIND,
  chat_action: "chat_action"
} as const

export interface ChatActionRetirementSource {
  readonly kind: typeof TASK_PROPOSAL_RETIREMENT_SOURCE.chat_action
  readonly session_id: string
  readonly turn_id: string
  readonly run_id: string
  readonly tool_call_id: string
  readonly revision: string
}

export type TaskProposalRetirementSource = SpaceTaskSource | ChatActionRetirementSource

export const TASK_PROPOSAL_CONFLICT = {
  proposal_changed: "proposal_changed",
  source_changed: "source_changed",
  source_unavailable: "source_unavailable",
  space_unavailable: "space_unavailable",
  settled: "settled",
  not_offered: "not_offered"
} as const

export type TaskProposalConflictKind =
  (typeof TASK_PROPOSAL_CONFLICT)[keyof typeof TASK_PROPOSAL_CONFLICT]

export interface TaskProposalConflict {
  readonly kind: TaskProposalConflictKind
  readonly message: string
}

export const TASK_PROPOSAL_REVIEW_STATE = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  unrequested: "unrequested"
} as const

export type TaskProposalReviewState = Exclude<
  (typeof TASK_PROPOSAL_REVIEW_STATE)[keyof typeof TASK_PROPOSAL_REVIEW_STATE],
  typeof TASK_PROPOSAL_REVIEW_STATE.unrequested
>

export interface TaskProposalReview {
  readonly expected_revision: number
  readonly state: TaskProposalReviewState
  readonly message: string
  readonly proposal: TaskProposal
}

export type TaskProposalReviewStatus =
  | { readonly state: typeof TASK_PROPOSAL_REVIEW_STATE.unrequested }
  | TaskProposalReview

export interface RecheckTaskProposalInput {
  readonly expected_revision: number
}
