import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import type { RecordedHistoryInput, RecordedHistoryPage, RecordedHistoryError } from "../history.js"
import { storeErrorFields } from "../errors.js"
import type { RuntimeRunStatus, SessionPresentation } from "@arden-hq/protocol"
import type { SessionType } from "@arden-hq/protocol/sessions"
import { Context, Effect, Schema } from "effect"
import type { StoredFork } from "./fork.js"
import type { SessionForkOrigin } from "./fork-origin.js"
import type { StoredTriage } from "./triage.js"
import type { CaptureForward } from "./capture.js"

export class SessionStoreError extends Schema.TaggedError<SessionStoreError>()(
  "SessionStoreError",
  {
    ...storeErrorFields({
      operations: [
        "list",
        "list_archived",
        "create",
        "branch",
        "rename",
        "move",
        "archive",
        "restore",
        "continue",
        "delete",
        "clear",
        "revert",
        "triage",
        "capture"
      ],
      reasons: ["invalid", "not_found", "conflict", "storage"]
    }),
    sessionId: Schema.optionalKey(Schema.NonEmptyString)
  }
) {}

export interface SessionListQuery {
  readonly spaceId?: string
  readonly inbox?: boolean
  readonly scope?: "primary" | "agent" | "all"
  readonly live?: boolean
  readonly parentSessionIds?: ReadonlyArray<string>
  readonly limit?: number
  readonly offset?: number
  readonly sort?: "activity" | "accessed"
  readonly cursor?: { readonly at: string; readonly sessionId: string }
  readonly sessionIds?: ReadonlyArray<string>
  readonly sessionRef?: string
  readonly includeArchived?: boolean
}

export interface StoredSession {
  readonly sessionId: string
  readonly publicRef: string
  readonly startedAt: string
  readonly lastActivity: string
  readonly lastAccessedAt: string | undefined
  readonly name: string | undefined
  readonly messageCount: number
  readonly spaceId: string | undefined
  readonly chatModel: string | undefined
  readonly sessionType: SessionType
  readonly originAutomationId: string | undefined
  readonly parentSessionId: string | undefined
  readonly parentRunId: string | undefined
  readonly parentToolCallId: string | undefined
  readonly parentMessageId: string | undefined
}

export interface SessionListEntry extends StoredSession {
  readonly currentActivity?: import("@arden-hq/protocol/chat").RunActivity | undefined
  readonly agentWorkspace?: string | undefined
  readonly latestRunId?: string | undefined
  readonly presentation: SessionPresentation
  readonly spaceName: string | undefined
  readonly archivedAt: string | undefined
  readonly hasUnread: boolean
  readonly latestRun:
    | {
        readonly status: RuntimeRunStatus
        readonly errorCode: string | undefined
        readonly stopReason: string | undefined
      }
    | undefined
  readonly activeRun: { readonly runId: string; readonly turnId: string } | undefined
  readonly checkpointSeq: number
  readonly latestEventSeq: number
  readonly pendingApprovalsCount: number
  readonly pendingConnectionsCount: number
  readonly triage: StoredTriage | undefined
  readonly fork: StoredFork | undefined
  readonly forkOrigin: SessionForkOrigin | undefined
  readonly threadSource:
    | { readonly sessionId: string; readonly sessionRef: string | null }
    | undefined
  readonly summary: string | undefined
  readonly origin: "capture" | "onboarding" | undefined
}

export type ArchiveWhenIdle =
  | { readonly kind: "kept" }
  | { readonly kind: "gone" }
  | { readonly kind: "automations"; readonly names: ReadonlyArray<string> }

export interface PendingArchive {
  readonly sessionId: string
  readonly mutation: MutationOperationIdentity
}

export interface ArchivedSessionEntry extends StoredSession {
  readonly archivedAt: string
  readonly firstLine: string | null
}

export interface NewSession {
  readonly name?: string | undefined
  readonly spaceId?: string | undefined
  readonly origin?: "capture" | "onboarding" | undefined
  readonly commandLine?: true | undefined
}

export interface CreatedSession {
  readonly sessionId: string
  readonly name: string | undefined
  readonly startedAt: string
  readonly lastActivity: string
  readonly messageCount: number
  readonly spaceId: string | undefined
  readonly chatModel: string | undefined
  readonly origin: "capture" | "onboarding" | undefined
}

export interface OwnChatMove {
  readonly when: "now" | "run_end"
  readonly spaceName: string | undefined
}

export interface BranchOptions {
  readonly disposition?: "retained" | "disposable" | undefined
  readonly name?: string | undefined
  readonly upToMessageId?: string | undefined
  readonly requestId?: string | undefined
  readonly shareResources?: boolean | undefined
}

export interface BranchedSession {
  readonly sessionId: string
  readonly name: string | undefined
  readonly startedAt: string
  readonly lastActivity: string
  readonly spaceId: string | undefined
  readonly forkOrigin: SessionForkOrigin
}

export interface RevertOptions {
  readonly sessionId?: string | undefined
  readonly turns?: number | undefined
  readonly messageId?: string | undefined
}

export interface RevertedTurns {
  readonly userMessage: string
  readonly revertedCount: number
}

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly history: (
      input: RecordedHistoryInput
    ) => Effect.Effect<RecordedHistoryPage, RecordedHistoryError>
    readonly list: (
      query?: SessionListQuery
    ) => Effect.Effect<ReadonlyArray<SessionListEntry>, SessionStoreError>
    readonly listArchived: () => Effect.Effect<
      ReadonlyArray<ArchivedSessionEntry>,
      SessionStoreError
    >
    readonly create: (session: NewSession) => Effect.Effect<CreatedSession, SessionStoreError>
    readonly commandLineChat: (
      target: { readonly sessionId: string } | { readonly runId: string }
    ) => Effect.Effect<boolean, SessionStoreError>
    readonly ensureSpaceConversation: (spaceId: string) => Effect.Effect<string, SessionStoreError>
    readonly branch: (
      sessionId: string,
      options: BranchOptions
    ) => Effect.Effect<BranchedSession | undefined, SessionStoreError>
    readonly completeBranchPreparation: (input: {
      readonly childSessionId: string
    }) => Effect.Effect<boolean, SessionStoreError>
    readonly preparingForks: (input?: { readonly childSessionId?: string }) => Effect.Effect<
      ReadonlyArray<{
        readonly childSessionId: string
        readonly sourceSessionId: string
        readonly hasOwnerContent: boolean
      }>,
      SessionStoreError
    >
    readonly rename: (
      sessionId: string,
      name: string,
      mutation?: MutationOperationIdentity
    ) => Effect.Effect<string | undefined, SessionStoreError>
    readonly renameIfEmpty: (
      sessionId: string,
      name: string
    ) => Effect.Effect<boolean, SessionStoreError>
    readonly moveToSpace: (
      sessionId: string,
      spaceId: string | undefined
    ) => Effect.Effect<boolean, SessionStoreError>
    readonly moveFromRun: (
      runId: string,
      spaceId: string | undefined,
      toolCallId?: string
    ) => Effect.Effect<OwnChatMove | undefined, SessionStoreError>
    readonly saveCaptureForward: (
      sessionId: string,
      forwarded: CaptureForward
    ) => Effect.Effect<boolean, SessionStoreError>
    readonly saveTriage: (
      sessionId: string,
      triage: StoredTriage
    ) => Effect.Effect<boolean, SessionStoreError>
    readonly adoptSpaceConversation: (
      spaceId: string,
      sessionId: string
    ) => Effect.Effect<void, SessionStoreError>
    readonly releaseSpaceConversation: (
      spaceId: string,
      sessionId: string
    ) => Effect.Effect<void, SessionStoreError>
    readonly archive: (
      sessionId: string,
      mutation?: MutationOperationIdentity
    ) => Effect.Effect<boolean, SessionStoreError>
    readonly restore: (sessionId: string) => Effect.Effect<boolean, SessionStoreError>
    readonly archiveWhenIdle: (
      sessionId: string,
      mutation: MutationOperationIdentity
    ) => Effect.Effect<ArchiveWhenIdle, SessionStoreError>
    readonly pendingArchives: () => Effect.Effect<ReadonlyArray<PendingArchive>, SessionStoreError>
    readonly continueRun: (sessionId: string) => Effect.Effect<boolean, SessionStoreError>
    readonly permanentDelete: (sessionId: string) => Effect.Effect<boolean, SessionStoreError>
    readonly clear: (sessionId?: string) => Effect.Effect<string | undefined, SessionStoreError>
    readonly revert: (
      options: RevertOptions
    ) => Effect.Effect<RevertedTurns | undefined, SessionStoreError>
  }
>()("@arden-hq/server/persistence/sessions/SessionStore") {}
