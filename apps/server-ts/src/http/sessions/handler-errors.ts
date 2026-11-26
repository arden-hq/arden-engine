import { Match } from "effect"
import {
  RUNNING_WORK,
  SESSION_LIST_SORT,
  type SessionListSort,
  type SessionListCursor
} from "@arden-hq/protocol/sessions"
import { HttpApiError } from "effect/unstable/httpapi"
import { type SpaceStoreError } from "../../persistence/spaces/store.js"
import { type SessionQueryFailure } from "../../persistence/sessions/queries.js"
import { SessionReadStateError } from "../../persistence/sessions/read-state.js"
import { SessionStoreError, type SessionListEntry } from "../../persistence/sessions/store.js"
import { type SessionTriageConflict } from "../../assist/session-triage.js"
import { StoreConflict, storeErrorToHttp, StoreInvalid } from "../errors.js"
import { sessionListCursorToWire } from "../wire/sessions.js"
import {
  CONVERSATION_ERROR_REASON,
  ConversationArtifactError
} from "../../artifacts/conversation-model.js"
import { STORE_REASON } from "../../persistence/errors.js"
import type { ChatMessageFailure } from "../../chat/message-errors.js"
import type { RunQueryError } from "../../persistence/runs/queries.js"
import type { ScriptStoreError } from "../../persistence/scripts/store.js"
import type { WorkStoreError } from "../../persistence/work/store.js"

export type SessionHttpError =
  | StoreConflict
  | StoreInvalid
  | HttpApiError.InternalServerError
  | HttpApiError.NotFound

export const triageActionError = (
  error: SessionTriageConflict | SessionStoreError | SpaceStoreError | SessionQueryFailure
): SessionHttpError =>
  Match.value(error).pipe(
    Match.tag(
      "SessionTriageConflict",
      (conflict): SessionHttpError => new StoreConflict({ detail: conflict.message })
    ),
    Match.tag(
      "SessionQueryError",
      "SessionDataCorruptionError",
      (): SessionHttpError => new HttpApiError.InternalServerError({})
    ),
    Match.orElse((other): SessionHttpError => storeErrorToHttp(other))
  )

export type EndConflict = {
  readonly detail: string
  readonly running: { readonly kind: typeof RUNNING_WORK.none }
}

export const endRefusal = (
  error: SessionStoreError | RunQueryError | ScriptStoreError | WorkStoreError | ChatMessageFailure
): SessionHttpError | EndConflict =>
  Match.valueTags(error, {
    SessionStoreError: (failure): SessionHttpError | EndConflict =>
      failure.reason === STORE_REASON.conflict
        ? { detail: failure.message, running: { kind: RUNNING_WORK.none } }
        : storeErrorToHttp(failure),
    RunQueryError: () => new HttpApiError.InternalServerError({}),
    ScriptStoreError: () => new HttpApiError.InternalServerError({}),
    WorkStoreError: () => new HttpApiError.InternalServerError({}),
    ChatMessageError: () => new HttpApiError.InternalServerError({}),
    ChatMessageConflictError: () => new HttpApiError.InternalServerError({})
  })

export const readError = (_error: SessionReadStateError): HttpApiError.InternalServerError =>
  new HttpApiError.InternalServerError({})

export const artifactHttpError = (error: ConversationArtifactError): SessionHttpError => {
  if (error.reason === CONVERSATION_ERROR_REASON.quota)
    return new HttpApiError.InternalServerError({})
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

export const CHAT_SEARCH_LIMIT = 20

export const sessionCursor = (
  session: SessionListEntry,
  sort: SessionListSort
): SessionListCursor =>
  sessionListCursorToWire({
    at:
      sort === SESSION_LIST_SORT.accessed
        ? (session.lastAccessedAt ?? session.lastActivity)
        : session.lastActivity,
    sessionId: session.sessionId
  })
