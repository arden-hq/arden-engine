import type { JsonRecord } from "../common/json.js"

export const COMMUNICATION_DOOR = {
  task: "task",
  session: "session",
  automation: "automation",
  run: "run",
  automationRun: "automation_run",
  artifact: "artifact"
} as const

export const ARRIVAL_EVENT = {
  finished: "finished",
  blocked: "blocked",
  needsYou: "needs_you",
  failed: "failed",
  paused: "paused",
  told: "told",
  met: "met"
} as const

export interface TaskCommunicationDoor extends JsonRecord {
  readonly kind: typeof COMMUNICATION_DOOR.task
  readonly label: string
  readonly item_id: string
  readonly href: string
}

export interface SessionCommunicationDoor extends JsonRecord {
  readonly kind: typeof COMMUNICATION_DOOR.session
  readonly label: string
  readonly session_ref: string
  readonly href: string
}

export interface AutomationCommunicationDoor extends JsonRecord {
  readonly kind: typeof COMMUNICATION_DOOR.automation
  readonly label: string
  readonly automation_ref: string
  readonly href: string
}

export interface RunCommunicationDoor extends JsonRecord {
  readonly kind: typeof COMMUNICATION_DOOR.run
  readonly label: string
  readonly run_id: string
  readonly session_ref: string
  readonly href: string
}

export interface AutomationRunCommunicationDoor extends JsonRecord {
  readonly kind: typeof COMMUNICATION_DOOR.automationRun
  readonly label: string
  readonly automation_ref: string
  readonly run_id: string
  readonly session_ref: string
  readonly href: string
}

export interface ArtifactCommunicationDoor extends JsonRecord {
  readonly kind: typeof COMMUNICATION_DOOR.artifact
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
  readonly destination_session_ref: string
  readonly source_sequence: number
  readonly occurred_at: string
  readonly payload_hash: string
  readonly line: string
  readonly door: CommunicationDoor
}

export type CommunicationArrival =
  | (CommunicationArrivalBase & { readonly event: typeof ARRIVAL_EVENT.finished })
  | (CommunicationArrivalBase & { readonly event: typeof ARRIVAL_EVENT.blocked })
  | (CommunicationArrivalBase & {
      readonly event: typeof ARRIVAL_EVENT.needsYou
      readonly attention: CommunicationAttentionReference
    })
  | (CommunicationArrivalBase & { readonly event: typeof ARRIVAL_EVENT.failed })
  | (CommunicationArrivalBase & { readonly event: typeof ARRIVAL_EVENT.paused })
  | (CommunicationArrivalBase & { readonly event: typeof ARRIVAL_EVENT.told })
  | (CommunicationArrivalBase & { readonly event: typeof ARRIVAL_EVENT.met })

export type ArrivalEvent = (typeof ARRIVAL_EVENT)[keyof typeof ARRIVAL_EVENT]

export type UpdateEvent = Exclude<ArrivalEvent, typeof ARRIVAL_EVENT.needsYou>

export const UPDATE_WEIGHT = { owed: "owed", news: "news" } as const

export type UpdateWeight = (typeof UPDATE_WEIGHT)[keyof typeof UPDATE_WEIGHT]

export interface ChatUpdate extends JsonRecord {
  readonly key: string
  readonly weight: UpdateWeight
  readonly event: UpdateEvent
  readonly line: string
  readonly door: CommunicationDoor
}

export type CommunicationEnvelope = {
  readonly kind: "arrival"
  readonly arrival: CommunicationArrival
}
