import type { ChatRunningWork } from "../sessions/contracts.js"
import type { JsonRecord } from "../common/json.js"
import type { SpaceSnapshot, SpaceTaskOwner, SpaceTaskStatus } from "./work/contracts.js"

export type SpaceApprovalMode = "read_only" | "ask" | "safe" | "allow"

export interface TaskInferencePolicy extends JsonRecord {
  readonly enabled: boolean
}
/** Every Space suggests tasks; its review runs while it has a Memory page. */
export const DEFAULT_TASK_INFERENCE_POLICY: TaskInferencePolicy = { enabled: true }

/** How many Local folders a Space or loose chat keeps, and how long each path may be. */
export const LOCAL_FOLDER_LIMITS = { count: 32, length: 1_000 } as const

/** The colours a Space's mark can take: the pastels, then mono: white light on a dark theme,
 *  black ink on a light one. */
export const SPACE_MARK_COLOURS = [
  "peach",
  "butter",
  "mint",
  "aqua",
  "sky",
  "lavender",
  "orchid",
  "mono"
] as const
export type SpaceMarkColour = (typeof SPACE_MARK_COLOURS)[number]

/** What makes a mark's light: the caustic pool or a long swell. */
export const SPACE_MARK_MEDIA = ["pool", "swell"] as const
export type SpaceMarkMedium = (typeof SPACE_MARK_MEDIA)[number]

export const MARK_COLOUR_CHOICE = { automatic: "automatic", chosen: "chosen" } as const

export type SpaceMarkColourChoice =
  | { readonly kind: "automatic" }
  | { readonly kind: "chosen"; readonly colour: SpaceMarkColour }

export interface SpaceMarkLook extends JsonRecord {
  readonly colour: SpaceMarkColourChoice
  readonly medium: SpaceMarkMedium
  readonly zoom: number
  readonly aberration: number
  readonly focus: number
}

export const SPACE_MARK = { automatic: "automatic", set: "set" } as const

export type SpaceMark =
  | { readonly kind: "automatic" }
  | { readonly kind: "set"; readonly look: SpaceMarkLook }

export const SPACE_KINDS = ["ordinary", "main"] as const
export type SpaceKind = (typeof SPACE_KINDS)[number]

export const SPACE_INSTRUCTIONS = {
  unwritten: "unwritten",
  cleared: "cleared",
  manual: "manual",
  generated: "generated"
} as const

export type SpaceInstructions =
  | { readonly kind: "unwritten" }
  | { readonly kind: "cleared" }
  | { readonly kind: "manual"; readonly text: string }
  | { readonly kind: "generated"; readonly text: string }

export const SPACE_PAGE = { unbound: "unbound", bound: "bound" } as const

export type SpacePage =
  | { readonly kind: "unbound" }
  | { readonly kind: "bound"; readonly path: string }

export const SPACE_STATE = { active: "active", archived: "archived" } as const

export type SpaceState =
  | { readonly kind: "active" }
  | { readonly kind: "archived"; readonly archived_at: string }

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
  | { readonly kind: "cleared" }
  | { readonly kind: "written"; readonly text: string }

export interface CreateSpaceInput {
  readonly name: string
  readonly instructions: { readonly kind: "unwritten" } | SpaceInstructionsInput
}

export const SPACE_CHANGE = { name: "name", instructions: "instructions", mark: "mark" } as const

export type SpaceChange =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "instructions"; readonly instructions: SpaceInstructionsInput }
  | { readonly kind: "mark"; readonly mark: SpaceMark }

export const SPACE_EXPECTED = { latest: "latest", at: "at" } as const

export type SpaceExpectedVersion =
  | { readonly kind: "latest" }
  | { readonly kind: "at"; readonly updated_at: string }

export interface UpdateSpaceInput {
  readonly expected: SpaceExpectedVersion
  readonly changes: ReadonlyArray<SpaceChange>
}

export interface SpaceArchiveResponse extends JsonRecord {
  readonly status: "archived"
  readonly space_id: string
}

/** A Space archive refused while its chats have work running: each busy chat and what runs. */
export interface SpaceEndConflict extends JsonRecord {
  readonly detail: string
  readonly chats: ReadonlyArray<{ readonly name: string; readonly running: ChatRunningWork }>
}

export const LETTER_SUBJECT = { none: "none", given: "given" } as const

export type LetterSubject =
  | { readonly kind: "none" }
  | { readonly kind: "given"; readonly subject: string }

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
  | { readonly kind: "caught_up" }
  | ({ readonly kind: "unseen" } & SpaceUnseen)

export const LAST_LINE = { none: "none", line: "line" } as const

export type LastLine = { readonly kind: "none" } | { readonly kind: "line"; readonly text: string }

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

/** The Spaces the owner placed first, in the order they placed them; every
 *  other Space follows by its latest chat. */
export interface PinnedSpacesInput extends JsonRecord {
  readonly space_ids: ReadonlyArray<string>
}

export interface SpacesOverview extends JsonRecord {
  readonly spaces: ReadonlyArray<SpaceSummary>
  readonly unseen: ReadonlyArray<SpaceUnseenEntry>
  readonly brief: SpacesBrief
}

export type SpaceAgentAvailability = "ready" | "stale" | "unavailable" | "error"

export const AGENT_LATEST_RUN = { none: "none", run: "run" } as const
export const AGENT_CHECKED = { never: "never", at: "at" } as const
export const AGENT_REPORT = { none: "none", report: "report" } as const
export const AGENT_RUNNING = { idle: "idle", running: "running" } as const
export const AGENT_ERROR = { none: "none", failed: "failed" } as const

export interface SpaceAgentStatus extends JsonRecord {
  readonly latest_run: { readonly kind: "none" } | { readonly kind: "run"; readonly run_id: string }
  readonly last_checked: { readonly kind: "never" } | { readonly kind: "at"; readonly at: string }
  readonly last_report:
    | { readonly kind: "none" }
    | { readonly kind: "report"; readonly text: string }
  readonly woken_by: ReadonlyArray<string>
  readonly runs_today: number
  readonly runs_cap: number
  readonly running: { readonly kind: "idle" } | { readonly kind: "running"; readonly since: string }
  readonly availability: SpaceAgentAvailability
  readonly last_error:
    | { readonly kind: "none" }
    | { readonly kind: "failed"; readonly error: string }
}

export const SPACE_AGENT = { off: "off", on: "on" } as const

export type SpaceAgent =
  | { readonly kind: "off" }
  | { readonly kind: "on"; readonly status: SpaceAgentStatus }

export const SESSION_NAME = { untitled: "untitled", named: "named" } as const

export type SessionName =
  | { readonly kind: "untitled" }
  | { readonly kind: "named"; readonly name: string }

export const CHAT_SUMMARY = { unsummarized: "unsummarized", summarized: "summarized" } as const

export type ChatSummaryState =
  | { readonly kind: "unsummarized" }
  | { readonly kind: "summarized"; readonly text: string }

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
  | { readonly kind: "unopened" }
  | { readonly kind: "opened"; readonly session_id: string }

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
