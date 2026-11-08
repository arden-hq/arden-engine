import type { BrowserScopeInput, BrowserScopeSnapshot } from "@arden-hq/protocol/browser-scope"
import { Context, Effect, Schema } from "effect"
import type { SessionToolEvidenceInput, SessionToolEvidencePage } from "./tool-evidence.js"
import type { StoredCapture } from "./capture.js"
import type {
  ActiveSessionSnapshot,
  AgentChildReference,
  SessionHeaderSnapshot,
  SessionHistoryHeader,
  SessionNameSeed
} from "./model.js"

export class SessionQueryError extends Schema.TaggedError<SessionQueryError>()(
  "SessionQueryError",
  {
    reason: Schema.tag("storage"),
    operation: Schema.Literals([
      "load",
      "history_header",
      "agent_children",
      "name_seed",
      "space_work_origin",
      "blocking_work",
      "session_ref",
      "capture",
      "tool_evidence",
      "space_chats",
      "browser_scope"
    ] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class SessionDataCorruptionError extends Schema.TaggedError<SessionDataCorruptionError>()(
  "SessionDataCorruptionError",
  {
    reason: Schema.tag("corrupt"),
    sessionId: Schema.NonEmptyString,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export type SessionQueryFailure = SessionQueryError | SessionDataCorruptionError

export class SessionQueries extends Context.Service<
  SessionQueries,
  {
    readonly browserScope: (
      input: BrowserScopeInput
    ) => Effect.Effect<BrowserScopeSnapshot | undefined, SessionQueryFailure>
    readonly readToolEvidence: (
      input: SessionToolEvidenceInput
    ) => Effect.Effect<SessionToolEvidencePage, SessionQueryFailure>
    readonly load: (
      sessionId?: string
    ) => Effect.Effect<ActiveSessionSnapshot | null, SessionQueryFailure>
    readonly loadHeaderSnapshot: (
      sessionId?: string
    ) => Effect.Effect<SessionHeaderSnapshot | null, SessionQueryFailure>
    readonly loadHistoryHeader: (
      sessionId?: string
    ) => Effect.Effect<SessionHistoryHeader | null, SessionQueryFailure>
    readonly sessionIdForRef: (
      publicRef: string
    ) => Effect.Effect<string | null, SessionQueryFailure>
    readonly listDirectAgentChildren: (
      sessionId: string
    ) => Effect.Effect<ReadonlyArray<AgentChildReference>, SessionQueryFailure>
    readonly loadCapture: (
      sessionId: string
    ) => Effect.Effect<StoredCapture | undefined, SessionQueryFailure>
    readonly loadNameSeed: (
      sessionId: string
    ) => Effect.Effect<SessionNameSeed | null, SessionQueryFailure>
    readonly blockingWork: (sessionId: string) => Effect.Effect<boolean, SessionQueryFailure>
    readonly openSpaceChats: (
      spaceId: string
    ) => Effect.Effect<
      ReadonlyArray<{ readonly sessionId: string; readonly name: string | null }>,
      SessionQueryFailure
    >
  }
>()("@arden-hq/server/persistence/sessions/SessionQueries") {}
