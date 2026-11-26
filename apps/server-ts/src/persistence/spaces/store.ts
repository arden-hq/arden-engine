import { type SnapshotRecord } from "../work/task-record.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import type { RecordedHistoryInput, RecordedHistoryPage, RecordedHistoryError } from "../history.js"
import { storeErrorFields } from "../errors.js"
import type {
  CreateSpaceInput,
  SpaceArchiveResponse,
  SpaceAgentAvailability,
  SpaceKind,
  SpacesOverview,
  TaskInferencePolicy,
  UpdateSpaceInput
} from "@arden-hq/protocol/spaces"
import { Context, Effect, Schema } from "effect"
import type { StoredMarkLook } from "./mark.js"

export const INSTRUCTIONS_SOURCE = { manual: "manual", generated: "generated" } as const

export type SpaceInstructionsSource = (typeof INSTRUCTIONS_SOURCE)[keyof typeof INSTRUCTIONS_SOURCE]

export interface SpaceRecord {
  readonly inference: TaskInferencePolicy
  readonly space_id: string
  readonly kind: SpaceKind
  readonly name: string
  readonly instructions: string | null
  readonly instructions_source: SpaceInstructionsSource | null
  readonly page_path: string | null
  readonly mark: StoredMarkLook | null
  readonly created_at: string
  readonly updated_at: string
  readonly archived_at: string | null
}

export type PersistedSpace = SpaceRecord & { readonly page_id: string | null }

export interface SpaceSessionRecord {
  readonly session_id: string
  readonly session_ref: string
  readonly name: string | null
  readonly last_line: string | null
  readonly summary: string | null
  readonly last_activity: string
}

export interface SpaceAgentRecord {
  readonly latest_run_id: string | null
  readonly last_checked: string | null
  readonly last_report: string | null
  readonly woken_by: ReadonlyArray<string>
  readonly runs_today: number
  readonly runs_cap: number
  readonly running_since: string | null
  readonly availability: SpaceAgentAvailability
  readonly last_error: string | null
}

export interface SpaceDetailRecord {
  readonly space: SpaceRecord
  readonly conversation_session_id: string | null
  readonly agent: SpaceAgentRecord | null
  readonly sessions: ReadonlyArray<SpaceSessionRecord>
  readonly work: SnapshotRecord
}

export interface SpaceBindingRow {
  readonly space_id: string
  readonly page_id: string | null
  readonly page_path: string | null
}

export interface SpacePageBinding {
  readonly pageId: string
  readonly pagePath: string
}

declare const checkedFree: unique symbol
export type FreeSpacePage = SpacePageBinding & { readonly [checkedFree]: true }

export const spaceChoices = (
  spaces: ReadonlyArray<{ readonly space_id: string; readonly name: string }>
): string =>
  spaces.length === 0
    ? "There is no active Space."
    : `Pass space_id, one of: ${spaces.map((space) => `${space.name} (${space.space_id})`).join(", ")}.`

export const archiveRefusal = (space: { readonly kind: SpaceKind }): string | undefined =>
  space.kind === "main" ? "The Main Space cannot be archived." : undefined

export class SpaceStoreError extends Schema.TaggedError<SpaceStoreError>()("SpaceStoreError", {
  ...storeErrorFields({
    operations: [
      "list",
      "create",
      "get",
      "update",
      "archive",
      "restore",
      "page",
      "detail",
      "overview",
      "page_binding"
    ],
    reasons: ["invalid", "conflict", "storage"]
  }),
  spaceId: Schema.optionalKey(Schema.NonEmptyString)
}) {}

export class SpaceStore extends Context.Service<
  SpaceStore,
  {
    readonly history: (
      input: RecordedHistoryInput
    ) => Effect.Effect<RecordedHistoryPage, RecordedHistoryError>
    readonly list: () => Effect.Effect<ReadonlyArray<PersistedSpace>, SpaceStoreError>
    readonly listArchived: () => Effect.Effect<ReadonlyArray<PersistedSpace>, SpaceStoreError>
    readonly create: (
      input: CreateSpaceInput,
      mutation?: MutationOperationIdentity
    ) => Effect.Effect<PersistedSpace, SpaceStoreError>
    readonly get: (
      spaceId: string,
      includeArchived?: boolean
    ) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly update: (
      spaceId: string,
      input: UpdateSpaceInput,
      runId?: string,
      toolCallId?: string
    ) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly setGeneratedInstructions: (
      spaceId: string,
      instructions: string
    ) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly bindPage: (
      spaceId: string,
      page: FreeSpacePage
    ) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly archive: (
      spaceId: string,
      mutation?: MutationOperationIdentity
    ) => Effect.Effect<SpaceArchiveResponse | null, SpaceStoreError>
    readonly restore: (
      spaceId: string,
      page: FreeSpacePage | null
    ) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly detail: (
      spaceId: string,
      options?: { readonly recentChats?: number }
    ) => Effect.Effect<SpaceDetailRecord | null, SpaceStoreError>
    readonly recordLetterSubject: (
      sessionId: string,
      messageId: string,
      subject: string
    ) => Effect.Effect<void, SpaceStoreError>
    readonly linkChat: (
      spaceId: string,
      sessionId: string,
      throughSequence: number
    ) => Effect.Effect<boolean, SpaceStoreError>
    readonly unlinkedSpaces: (
      sessionId: string,
      throughSequence: number,
      spaceIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<string>, SpaceStoreError>
    readonly overview: () => Effect.Effect<SpacesOverview, SpaceStoreError>
    readonly setPinned: (spaceIds: ReadonlyArray<string>) => Effect.Effect<void, SpaceStoreError>
    readonly activeBindings: () => Effect.Effect<ReadonlyArray<SpaceBindingRow>, SpaceStoreError>
  }
>()("@arden-hq/server/persistence/spaces/SpaceStore") {}
