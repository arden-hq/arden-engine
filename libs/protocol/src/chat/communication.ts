import type { JsonRecord } from "../common/json.js"

export interface TaskCommunicationDoor extends JsonRecord {
  readonly kind: "task"
  readonly label: string
  readonly item_id: string
  readonly href: string
}

export interface SessionCommunicationDoor extends JsonRecord {
  readonly kind: "session"
  readonly label: string
  readonly session_ref: string
  readonly href: string
}

export interface AutomationCommunicationDoor extends JsonRecord {
  readonly kind: "automation"
  readonly label: string
  readonly automation_ref: string
  readonly href: string
}

/** A Run opens through its owning Session; the current navigator has no separate Run route. */
export interface RunCommunicationDoor extends JsonRecord {
  readonly kind: "run"
  readonly label: string
  readonly run_id: string
  readonly session_ref: string
  readonly href: string
}

/** A run of an Automation, reported into a chat it did not work in: named by its
 *  Automation (`label` is the Automation's name), opened through its Session. */
export interface AutomationRunCommunicationDoor extends JsonRecord {
  readonly kind: "automation_run"
  readonly label: string
  readonly automation_ref: string
  readonly run_id: string
  readonly session_ref: string
  readonly href: string
}

/** A saved Task artifact opens through its Task; attachment_id selects the file inside the peek. */
export interface ArtifactCommunicationDoor extends JsonRecord {
  readonly kind: "artifact"
  readonly label: string
  readonly item_id: string
  readonly attachment_id: number
  readonly href: string
}

export type CommunicationDoor =
  | TaskCommunicationDoor
  | SessionCommunicationDoor
  | AutomationCommunicationDoor
  | RunCommunicationDoor
  | AutomationRunCommunicationDoor
  | ArtifactCommunicationDoor

export type CommunicationAttentionReference =
  | { readonly kind: "question"; readonly question_id: string }
  | { readonly kind: "approval"; readonly approval_id: string }

export interface ContinuitySourceCursor extends JsonRecord {
  readonly arrivals_through: number
  readonly question_changes_through: number
}

interface CommunicationArrivalBase extends JsonRecord {
  readonly arrival_id: string
  readonly occurrence_key: string
  readonly source_run_id: string
  readonly source_session_ref: string
  readonly destination_space_id: string | null
  readonly destination_session_ref: string
  readonly source_sequence: number
  readonly occurred_at: string
  readonly payload_hash: string
  readonly line: string
  readonly door: CommunicationDoor
}

export type CommunicationArrival =
  | (CommunicationArrivalBase & { readonly event: "finished" })
  | (CommunicationArrivalBase & { readonly event: "blocked" })
  /** Legacy, read-only: no writer posts it any more; stored transcripts still hold it. */
  | (CommunicationArrivalBase & {
      readonly event: "needs_you"
      readonly attention: CommunicationAttentionReference
    })
  | (CommunicationArrivalBase & { readonly event: "failed" })
  /** An Automation stopped itself after failing again and again (D-12). */
  | (CommunicationArrivalBase & { readonly event: "paused" })
  /** A run said something to the owner before it ended (the `tell` tool). */
  | (CommunicationArrivalBase & { readonly event: "told" })
  /** A Task's done-when criterion was met: the line is the criterion, and
   *  the door opens its evidence (a saved result), else the Task. */
  | (CommunicationArrivalBase & { readonly event: "met" })

/** What happened, in an update that reached Arden as the input of a turn. */
export type UpdateEvent = "finished" | "blocked" | "failed" | "paused" | "told" | "met"

/**
 * On the meta message that brought a background update to Arden as its turn's
 * input. `owed`: Arden must assess the outstanding result. `news`: Arden
 * decides whether it changes the answer. Both remain internal model input.
 */
export interface ChatUpdate extends JsonRecord {
  /** The occurrence it reports (`ending:run:<id>`, `tell:<id>:<n>`, ...). */
  readonly key: string
  readonly weight: "owed" | "news"
  readonly event: UpdateEvent
  /** The record's own words, preserving Markdown and paragraph structure. */
  readonly line: string
  readonly door: CommunicationDoor
}

/** Canonical content stored on one capture/context-excluded meta transcript envelope. */
export type CommunicationEnvelope = {
  readonly kind: "arrival"
  readonly arrival: CommunicationArrival
  /** Legacy notification hint: false keeps the chat quiet. It does not
   *  authorize publishing the report; the envelope remains model input. */
  readonly shown?: boolean
}
