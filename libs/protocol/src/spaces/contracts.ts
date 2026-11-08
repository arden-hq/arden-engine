import type { ChatRunningWork } from "../sessions/contracts.js"
import type { JsonRecord } from "../common/json.js"
import type { SpaceSnapshot, SpaceTaskStatus } from "./work/contracts.js"

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

/** How the owner set a Space's mark. A Space without one shows the pool in its automatic colour. */
export interface SpaceMarkLook extends JsonRecord {
  /** null: the colour the Space got automatically. */
  readonly colour: SpaceMarkColour | null
  readonly medium: SpaceMarkMedium
  /** 0..1, from close in to far out. */
  readonly zoom: number
  /** 0..1, from a clean lens to a prism. */
  readonly aberration: number
  /** 0..1, from haze to hairline. */
  readonly focus: number
}

/** Who wrote a Space's standing instructions. Manual text is never overwritten. */
export type SpaceInstructionsSource = "manual" | "generated"

export interface Space extends JsonRecord {
  readonly inference: TaskInferencePolicy
  readonly space_id: string
  readonly name: string
  readonly instructions: string | null
  readonly instructions_source: SpaceInstructionsSource | null
  readonly page_path: string | null
  readonly mark: SpaceMarkLook | null
  readonly created_at: string
  readonly updated_at: string
  readonly archived_at: string | null
}

export interface SpaceListResponse extends JsonRecord {
  readonly spaces: ReadonlyArray<Space>
}

export interface CreateSpaceInput {
  readonly name: string
  readonly instructions?: string | null
}

export interface UpdateSpaceInput {
  readonly expected_updated_at?: string
  readonly name?: string
  readonly instructions?: string | null
  readonly page_path?: string | null
  readonly mark?: SpaceMarkLook | null
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

export interface SpaceUnseen extends JsonRecord {
  readonly at: string
  readonly session_id: string
  readonly line: string
  readonly subject: string | null
}

export interface SpaceUnseenEntry extends SpaceUnseen {
  readonly space_id: string
  readonly space_title: string
}

export interface SpaceSummary extends JsonRecord {
  readonly updated_at: string
  readonly key: string
  readonly title: string
  readonly page_path: string | null
  readonly live: boolean
  readonly pinned: boolean
  readonly mark: SpaceMarkLook | null
  readonly unseen: SpaceUnseen | null
  /** The last assistant reply from the latest conversation with a reply, flattened for the Space row. */
  readonly last_line?: string | null
}

export interface SpaceBriefItem extends JsonRecord {
  readonly space_id: string
  readonly space_title: string
  readonly stable_key: string
  readonly text: string
  readonly status?: SpaceTaskStatus
  readonly owner?: "worker" | "user" | "external"
  readonly completed_at: string | null
  readonly updated_at: string
}

export interface SpacesBrief extends JsonRecord {
  readonly done: ReadonlyArray<SpaceBriefItem>
  readonly in_progress: ReadonlyArray<SpaceBriefItem>
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

/** `stale` is a live board nothing has looked at for three days: silence,
 * not failure, and the state a "ready" worker used to hide. */
export type SpaceAgentAvailability = "ready" | "stale" | "unavailable" | "error"

export interface SpaceAgentStatus extends JsonRecord {
  readonly latest_run_id: string | null
  readonly last_checked: string | null
  readonly next_check: string | null
  readonly last_report: string | null
  readonly woken_by: ReadonlyArray<string>
  readonly runs_today: number
  readonly runs_cap: number
  readonly running_since: string | null
  readonly availability: SpaceAgentAvailability
  readonly last_error: string | null
}

/** Minimal fields required from the larger session-list projection. */
export interface SpaceSession extends JsonRecord {
  readonly session_id: string
  /** The chat's `arden:session/` reference, which tools and links take. */
  readonly session_ref?: string
  readonly name: string | null
  /** The assistant's last message as one plain line, for the Space page's chat rows; null when it has none. */
  readonly last_line?: string | null
  /** What the chat covered, from its Chat summary; absent until it has one. */
  readonly summary?: string | null
  readonly last_activity?: string
}

/** Where a Space stands, rolled up from its chats' summaries. */
export interface SpaceOverview extends JsonRecord {
  readonly now: string
  readonly next: ReadonlyArray<string>
  readonly updated_at: string
  readonly revision_id: number | null
  /** Source data only; a later generator policy change is checked separately. */
  readonly source_freshness: "fresh" | "stale" | "unknown"
}

export interface SpaceDetail extends JsonRecord {
  readonly conversation_session_id: string | null
  readonly inference: TaskInferencePolicy
  readonly key: string
  readonly title: string
  readonly page_path: string | null
  readonly instructions: string | null
  readonly agent: SpaceAgentStatus | null
  readonly sessions: ReadonlyArray<SpaceSession>
  /** Absent from older servers and until the Space's chats have summaries. */
  readonly overview?: SpaceOverview | null
  readonly work: SpaceSnapshot
}

export interface SpaceConversationResponse {
  readonly session_id: string
}
