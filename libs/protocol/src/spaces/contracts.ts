import type { ChatRunningWork } from "../sessions/contracts.js"
import type { JsonRecord } from "../common/json.js"
import type { ApprovalMode } from "../permissions/modes.js"
import type { SpaceSnapshot, SpaceTaskOwner, SpaceTaskStatus } from "./work/contracts.js"

export type SpaceApprovalMode = ApprovalMode

export interface TaskInferencePolicy extends JsonRecord {
  readonly enabled: boolean
}
export const DEFAULT_TASK_INFERENCE_POLICY: TaskInferencePolicy = { enabled: true }

export const LOCAL_FOLDER_LIMITS = { count: 32, length: 1_000 } as const

export const SPACE_MARK_COLOUR = {
  peach: "peach",
  butter: "butter",
  mint: "mint",
  aqua: "aqua",
  sky: "sky",
  lavender: "lavender",
  orchid: "orchid",
  mono: "mono"
} as const
export type SpaceMarkColour = (typeof SPACE_MARK_COLOUR)[keyof typeof SPACE_MARK_COLOUR]

export const SPACE_MARK_MEDIUM = { pool: "pool", swell: "swell" } as const
export type SpaceMarkMedium = (typeof SPACE_MARK_MEDIUM)[keyof typeof SPACE_MARK_MEDIUM]

export const MARK_COLOUR_CHOICE = { automatic: "automatic", chosen: "chosen" } as const

export type SpaceMarkColourChoice =
  | { readonly kind: typeof MARK_COLOUR_CHOICE.automatic }
  | { readonly kind: typeof MARK_COLOUR_CHOICE.chosen; readonly colour: SpaceMarkColour }

export interface SpaceMarkLook extends JsonRecord {
  readonly colour: SpaceMarkColourChoice
  readonly medium: SpaceMarkMedium
  readonly zoom: number
  readonly aberration: number
  readonly focus: number
}

export const SPACE_MARK = { automatic: "automatic", set: "set" } as const

export type SpaceMark =
  | { readonly kind: typeof SPACE_MARK.automatic }
  | { readonly kind: typeof SPACE_MARK.set; readonly look: SpaceMarkLook }

export const SPACE_KIND = { ordinary: "ordinary", main: "main" } as const
export type SpaceKind = (typeof SPACE_KIND)[keyof typeof SPACE_KIND]

export const SPACE_INSTRUCTIONS = {
  unwritten: "unwritten",
  cleared: "cleared",
  manual: "manual",
  generated: "generated"
} as const

export type SpaceInstructions =
  | { readonly kind: typeof SPACE_INSTRUCTIONS.unwritten }
  | { readonly kind: typeof SPACE_INSTRUCTIONS.cleared }
  | { readonly kind: typeof SPACE_INSTRUCTIONS.manual; readonly text: string }
  | { readonly kind: typeof SPACE_INSTRUCTIONS.generated; readonly text: string }

export const SPACE_PAGE = { unbound: "unbound", bound: "bound" } as const

export type SpacePage =
  | { readonly kind: typeof SPACE_PAGE.unbound }
  | { readonly kind: typeof SPACE_PAGE.bound; readonly path: string }

export const SPACE_STATE = { active: "active", archived: "archived" } as const

export type SpaceState =
  | { readonly kind: typeof SPACE_STATE.active }
  | { readonly kind: typeof SPACE_STATE.archived; readonly archived_at: string }

export interface Space extends JsonRecord {
  readonly inference: TaskInferencePolicy
  readonly space_id: string
  readonly kind: SpaceKind
  readonly name: string
  readonly instructions: SpaceInstructions
  readonly page: SpacePage
  readonly mark: SpaceMark
  readonly created_at: string
  readonly updated_at: string
  readonly state: SpaceState
}

export interface SpaceListResponse extends JsonRecord {
  readonly spaces: ReadonlyArray<Space>
}

export const SPACE_INSTRUCTIONS_INPUT = {
  unwritten: "unwritten",
  cleared: "cleared",
  written: "written"
} as const

export type SpaceInstructionsInput =
  | { readonly kind: typeof SPACE_INSTRUCTIONS_INPUT.cleared }
  | { readonly kind: typeof SPACE_INSTRUCTIONS_INPUT.written; readonly text: string }

export interface CreateSpaceInput {
  readonly name: string
  readonly instructions:
    | { readonly kind: typeof SPACE_INSTRUCTIONS_INPUT.unwritten }
    | SpaceInstructionsInput
}

export const SPACE_CHANGE = { name: "name", instructions: "instructions", mark: "mark" } as const

export type SpaceChange =
  | { readonly kind: typeof SPACE_CHANGE.name; readonly name: string }
  | {
      readonly kind: typeof SPACE_CHANGE.instructions
      readonly instructions: SpaceInstructionsInput
    }
  | { readonly kind: typeof SPACE_CHANGE.mark; readonly mark: SpaceMark }

export const SPACE_EXPECTED = { latest: "latest", at: "at" } as const

export type SpaceExpectedVersion =
  | { readonly kind: typeof SPACE_EXPECTED.latest }
  | { readonly kind: typeof SPACE_EXPECTED.at; readonly updated_at: string }

export interface UpdateSpaceInput {
  readonly expected: SpaceExpectedVersion
  readonly changes: ReadonlyArray<SpaceChange>
}

export interface SpaceArchiveResponse extends JsonRecord {
  readonly status: typeof SPACE_STATE.archived
  readonly space_id: string
}

export interface SpaceEndConflict extends JsonRecord {
  readonly detail: string
  readonly chats: ReadonlyArray<{ readonly name: string; readonly running: ChatRunningWork }>
}

export const LETTER_SUBJECT = { none: "none", given: "given" } as const

export type LetterSubject =
  | { readonly kind: typeof LETTER_SUBJECT.none }
  | { readonly kind: typeof LETTER_SUBJECT.given; readonly subject: string }

export interface SpaceUnseen extends JsonRecord {
  readonly at: string
  readonly session_id: string
  readonly line: string
  readonly subject: LetterSubject
}

export interface SpaceUnseenEntry extends SpaceUnseen {
  readonly space_id: string
  readonly space_title: string
}

export const SPACE_UNSEEN = { caught_up: "caught_up", unseen: "unseen" } as const

export type SpaceUnseenState =
  | { readonly kind: typeof SPACE_UNSEEN.caught_up }
  | ({ readonly kind: typeof SPACE_UNSEEN.unseen } & SpaceUnseen)

export const LAST_LINE = { none: "none", line: "line" } as const

export type LastLine =
  | { readonly kind: typeof LAST_LINE.none }
  | { readonly kind: typeof LAST_LINE.line; readonly text: string }

export interface SpaceSummary extends JsonRecord {
  readonly updated_at: string
  readonly key: string
  readonly kind: SpaceKind
  readonly title: string
  readonly page: SpacePage
  readonly live: boolean
  readonly pinned: boolean
  readonly mark: SpaceMark
  readonly unseen: SpaceUnseenState
  readonly last_line: LastLine
}

export interface SpaceBriefDone extends JsonRecord {
  readonly space_id: string
  readonly space_title: string
  readonly stable_key: string
  readonly text: string
  readonly completed_at: string
  readonly updated_at: string
}

export interface SpaceBriefActive extends JsonRecord {
  readonly space_id: string
  readonly space_title: string
  readonly stable_key: string
  readonly text: string
  readonly status: SpaceTaskStatus
  readonly owner: SpaceTaskOwner
  readonly updated_at: string
}

export interface SpacesBrief extends JsonRecord {
  readonly done: ReadonlyArray<SpaceBriefDone>
  readonly in_progress: ReadonlyArray<SpaceBriefActive>
}

export interface PinnedSpacesInput extends JsonRecord {
  readonly space_ids: ReadonlyArray<string>
}

export interface SpacesOverview extends JsonRecord {
  readonly spaces: ReadonlyArray<SpaceSummary>
  readonly unseen: ReadonlyArray<SpaceUnseenEntry>
  readonly brief: SpacesBrief
}

export const SPACE_AGENT_AVAILABILITY = {
  ready: "ready",
  stale: "stale",
  unavailable: "unavailable",
  error: "error"
} as const
export type SpaceAgentAvailability =
  (typeof SPACE_AGENT_AVAILABILITY)[keyof typeof SPACE_AGENT_AVAILABILITY]

export const AGENT_LATEST_RUN = { none: "none", run: "run" } as const
export const AGENT_CHECKED = { never: "never", at: "at" } as const
export const AGENT_REPORT = { none: "none", report: "report" } as const
export const AGENT_RUNNING = { idle: "idle", running: "running" } as const
export const AGENT_ERROR = { none: "none", failed: "failed" } as const

export interface SpaceAgentStatus extends JsonRecord {
  readonly latest_run:
    | { readonly kind: typeof AGENT_LATEST_RUN.none }
    | { readonly kind: typeof AGENT_LATEST_RUN.run; readonly run_id: string }
  readonly last_checked:
    | { readonly kind: typeof AGENT_CHECKED.never }
    | { readonly kind: typeof AGENT_CHECKED.at; readonly at: string }
  readonly last_report:
    | { readonly kind: typeof AGENT_REPORT.none }
    | { readonly kind: typeof AGENT_REPORT.report; readonly text: string }
  readonly woken_by: ReadonlyArray<string>
  readonly runs_today: number
  readonly runs_cap: number
  readonly running:
    | { readonly kind: typeof AGENT_RUNNING.idle }
    | { readonly kind: typeof AGENT_RUNNING.running; readonly since: string }
  readonly availability: SpaceAgentAvailability
  readonly last_error:
    | { readonly kind: typeof AGENT_ERROR.none }
    | { readonly kind: typeof AGENT_ERROR.failed; readonly error: string }
}

export const SPACE_AGENT = { off: "off", on: "on" } as const

export type SpaceAgent =
  | { readonly kind: typeof SPACE_AGENT.off }
  | { readonly kind: typeof SPACE_AGENT.on; readonly status: SpaceAgentStatus }

export const SESSION_NAME = { untitled: "untitled", named: "named" } as const

export type SessionName =
  | { readonly kind: typeof SESSION_NAME.untitled }
  | { readonly kind: typeof SESSION_NAME.named; readonly name: string }

export const CHAT_SUMMARY = { unsummarized: "unsummarized", summarized: "summarized" } as const

export type ChatSummaryState =
  | { readonly kind: typeof CHAT_SUMMARY.unsummarized }
  | { readonly kind: typeof CHAT_SUMMARY.summarized; readonly text: string }

export interface SpaceSession extends JsonRecord {
  readonly session_id: string
  readonly session_ref: string
  readonly name: SessionName
  readonly last_line: LastLine
  readonly summary: ChatSummaryState
  readonly last_activity: string
}

export const SPACE_CONVERSATION = { unopened: "unopened", opened: "opened" } as const

export type SpaceConversation =
  | { readonly kind: typeof SPACE_CONVERSATION.unopened }
  | { readonly kind: typeof SPACE_CONVERSATION.opened; readonly session_id: string }

export interface SpaceDetail extends JsonRecord {
  readonly conversation: SpaceConversation
  readonly inference: TaskInferencePolicy
  readonly key: string
  readonly title: string
  readonly page: SpacePage
  readonly instructions: SpaceInstructions
  readonly agent: SpaceAgent
  readonly sessions: ReadonlyArray<SpaceSession>
  readonly work: SpaceSnapshot
}

export interface SpaceConversationResponse {
  readonly session_id: string
}
