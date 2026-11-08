import type { SessionListScope, SessionListSort } from "@arden-hq/protocol/sessions"
import { DateTime, Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import {
  StructuredCompletion,
  StructuredCompletionError
} from "../../models/structured-completion.js"
import { SpaceStore, type SpaceStoreError } from "../../persistence/spaces/store.js"
import { ModelStore, ModelStoreError } from "../../persistence/models/store.js"
import { SessionQueries, type SessionQueryFailure } from "../../persistence/sessions/queries.js"
import { SessionReadState, SessionReadStateError } from "../../persistence/sessions/read-state.js"
import {
  SessionStore,
  SessionStoreError,
  type SessionListEntry,
  type SessionListQuery
} from "../../persistence/sessions/store.js"
import { TranscriptQueries } from "../../persistence/transcript/queries.js"
import {
  makeSessionExportModel,
  readSessionExportTranscript,
  renderSessionExport
} from "../../sessions/export.js"
import { makeSessionCreation } from "../../sessions/create.js"
import { ChatMessage } from "../../chat/message.js"
import { onboardingKickoff } from "../../chat/message-input.js"
import {
  makeSessionTriage,
  makeSessionTriageAction,
  type SessionTriageConflict
} from "../../assist/session-triage.js"
import { ArdenApi } from "../api.js"
import {
  completionErrorToHttp,
  failStore,
  orNotFound,
  StoreConflict,
  storeErrorToHttp
} from "../errors.js"
import { LocalCaller } from "../middleware/local-only.js"
import {
  archivedSessionToWire,
  branchedSessionToWire,
  createdSessionToWire,
  listedSessionToWire,
  sessionListCursorToWire
} from "../wire/sessions.js"
import { RunQueries } from "../../persistence/runs/queries.js"
import {
  artifactRole,
  ConversationArtifactError,
  ConversationArtifacts,
  type ConversationArtifactManifest
} from "../../artifacts/conversation.js"
import { sessionLineage } from "../../persistence/sessions/lineage.js"
import { HttpApiSchema } from "effect/unstable/httpapi"
import { SessionFileCleanup } from "../../storage/session-file-cleanup.js"
import { ChatStop, type ChatEnd } from "../../chat/chat-stop.js"
import { makeForkPreparation } from "../../chat/session-fork.js"
import { Memory } from "../../memory/service.js"
import type { ChatMessageFailure } from "../../chat/message-errors.js"
import type { RunQueryError } from "../../persistence/runs/queries.js"
import type { ScriptStoreError } from "../../persistence/scripts/store.js"
import type { WorkStoreError } from "../../persistence/work/store.js"

const visualizationToWire = (manifest: ConversationArtifactManifest, turnId?: string) => ({
  runtime_version: manifest.runtime_version,
  libraries: manifest.libraries,
  ref: manifest.ref,
  kind: manifest.kind,
  title: manifest.title,
  summary: manifest.summary,
  mode: manifest.mode,
  media_type: manifest.media_type,
  byte_length: manifest.byte_length,
  created_at: manifest.created_at,
  ...(manifest.kind === "file" ? { filename: manifest.filename } : {}),
  ...(manifest.producer_run_id === undefined ? {} : { producer_run_id: manifest.producer_run_id }),
  ...(manifest.operation_key === undefined ? {} : { operation_key: manifest.operation_key }),
  ...(turnId === undefined ? {} : { turn_id: turnId }),
  role: artifactRole(manifest)
})

const triageActionError = (
  error: SessionTriageConflict | SessionStoreError | SpaceStoreError | SessionQueryFailure
) => {
  if (error._tag === "SessionTriageConflict") return new StoreConflict({ detail: error.message })
  if (error._tag === "SessionQueryError" || error._tag === "SessionDataCorruptionError")
    return new HttpApiError.InternalServerError({})
  return storeErrorToHttp(error)
}

const endRefusal = (
  error: SessionStoreError | RunQueryError | ScriptStoreError | WorkStoreError | ChatMessageFailure
) => {
  switch (error._tag) {
    case "SessionStoreError":
      return error.reason === "conflict"
        ? { detail: error.message, running: null }
        : storeErrorToHttp(error)
    case "RunQueryError":
    case "ScriptStoreError":
    case "WorkStoreError":
    case "ChatMessageError":
    case "ChatMessageConflictError":
      return new HttpApiError.InternalServerError({})
  }
}

const readError = (_error: SessionReadStateError): HttpApiError.InternalServerError =>
  new HttpApiError.InternalServerError({})

const artifactHttpError = (error: ConversationArtifactError) => {
  if (error.reason === "quota") return new HttpApiError.InternalServerError({})
  return storeErrorToHttp({ reason: error.reason, message: error.message })
}

const listOptions = (query: {
  readonly space_id?: string
  readonly inbox?: boolean | "true" | "false"
  readonly scope?: SessionListScope
  readonly live?: boolean | "true" | "false"
  readonly parent_session_ids?: string
  readonly limit?: number
  readonly offset?: number
  readonly sort?: SessionListSort
  readonly cursor_at?: string
  readonly cursor_id?: string
  readonly session_ids?: string
  readonly session_ref?: string
}): SessionListQuery => ({
  ...(query.session_ref === undefined ? {} : { sessionRef: query.session_ref }),
  ...(query.space_id === undefined ? {} : { spaceId: query.space_id }),
  ...(query.inbox === undefined ? {} : { inbox: query.inbox === true || query.inbox === "true" }),
  ...(query.scope === undefined ? {} : { scope: query.scope }),
  ...(query.live === undefined ? {} : { live: query.live === true || query.live === "true" }),
  ...(query.parent_session_ids === undefined
    ? {}
    : {
        parentSessionIds: query.parent_session_ids.split(",").filter((id) => id.length > 0)
      }),
  ...(query.limit === undefined ? {} : { limit: query.limit }),
  ...(query.offset === undefined ? {} : { offset: query.offset }),
  ...(query.sort === undefined ? {} : { sort: query.sort }),
  ...(query.cursor_at === undefined || query.cursor_id === undefined
    ? {}
    : {
        cursor: { at: query.cursor_at, sessionId: query.cursor_id }
      }),
  ...(query.session_ids === undefined
    ? {}
    : {
        sessionIds: query.session_ids.split(",").filter((sessionId) => sessionId.length > 0)
      })
})

const CHAT_SEARCH_LIMIT = 30

const sessionCursor = (session: SessionListEntry, sort: SessionListSort) =>
  sessionListCursorToWire({
    at:
      sort === "accessed" ? (session.lastAccessedAt ?? session.lastActivity) : session.lastActivity,
    sessionId: session.sessionId
  })

export const SessionHandlers = HttpApiBuilder.group(
  ArdenApi,
  "sessions",
  Effect.fn(function* (handlers) {
    const store = yield* SessionStore
    const sessions = yield* SessionQueries
    const transcript = yield* TranscriptQueries
    const readState = yield* SessionReadState
    const memory = yield* Memory
    const models = yield* ModelStore
    const spaces = yield* SpaceStore
    const completion = yield* StructuredCompletion
    const artifacts = yield* ConversationArtifacts
    const runs = yield* RunQueries
    const fileCleanup = yield* SessionFileCleanup
    const chat = yield* ChatMessage
    const artifactLineage = Effect.fn("SessionHandlers.artifactLineage")(function* (
      sessionId: string
    ) {
      const header = yield* sessions
        .loadHistoryHeader(sessionId)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      if (header === null) return null
      return yield* sessionLineage(sessions, sessionId).pipe(
        Effect.map((lineage) => lineage.map((entry) => entry.sessionId)),
        Effect.tapError((error) =>
          Effect.logWarning("Artifact lineage failed", { sessionId, error })
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => [sessionId])
      )
    })
    const readInLineage = (lineage: ReadonlyArray<string>, ref: string) =>
      lineage
        .slice(1)
        .reduce(
          (found, owner) =>
            found.pipe(
              Effect.catchIf(
                (error) => error.reason === "not_found",
                () => artifacts.read(owner, ref)
              )
            ),
          artifacts.read(lineage[0] ?? "", ref)
        )
        .pipe(Effect.mapError(artifactHttpError))
    const creation = makeSessionCreation({ store, models })
    const kickoff = (sessionId: string) =>
      chat.send(onboardingKickoff(sessionId)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Onboarding chat opened without Arden's first message", {
            sessionId,
            cause
          })
        )
      )
    const triage = makeSessionTriage({ completion, sessions, spaces, store })
    const settleTriage = makeSessionTriageAction({ completion, sessions, spaces, store })
    const chatStop = yield* ChatStop
    const forkPreparation = makeForkPreparation({
      store,
      artifacts,
      stop: chatStop,
      cleanup: fileCleanup
    })
    const endChat = Effect.fn("SessionHandlers.endChat")(function* (
      sessionId: string,
      action: ChatEnd,
      stop: boolean | "true" | "false" = false
    ) {
      const ended = yield* chatStop
        .end({ sessionId, action, stop: stop === true || stop === "true" })
        .pipe(
          Effect.tapError((error) =>
            error._tag === "SessionStoreError"
              ? Effect.void
              : Effect.logWarning("Could not stop a chat's work", { sessionId, action, error })
          ),
          Effect.mapError(endRefusal)
        )
      switch (ended.kind) {
        case "ended":
          return
        case "not_found":
          return yield* new HttpApiError.NotFound({})
        case "running":
          return yield* Effect.fail({
            detail: "The chat still has work running",
            running: ended.running
          })
      }
    })

    return handlers
      .handle("browserScope", ({ payload }) =>
        sessions.browserScope(payload).pipe(
          Effect.mapError(() => new HttpApiError.InternalServerError({})),
          Effect.flatMap((snapshot) =>
            snapshot === undefined
              ? Effect.fail(new HttpApiError.NotFound({}))
              : Effect.succeed(snapshot)
          )
        )
      )
      .handle("configurationHistory", ({ params, query }) =>
        store.history({ id: params.sessionId, ...query }).pipe(Effect.catch(failStore))
      )
      .handle("clear", ({ payload }) =>
        store.clear(payload?.session_id ?? undefined).pipe(
          Effect.map((sessionId) => ({
            status: "cleared" as const,
            session_id: sessionId ?? null
          })),
          Effect.mapError(storeErrorToHttp)
        )
      )
      .handle("revert", ({ payload }) =>
        store
          .revert({
            sessionId: payload?.session_id ?? undefined,
            turns: payload?.turns,
            messageId: payload?.message_id ?? undefined
          })
          .pipe(
            Effect.flatMap((reverted) =>
              reverted === undefined
                ? Effect.fail(new HttpApiError.BadRequest({}))
                : Effect.succeed({
                    user_message: reverted.userMessage,
                    reverted_count: reverted.revertedCount
                  })
            ),
            Effect.catchTag("SessionStoreError", (error) => Effect.fail(storeErrorToHttp(error)))
          )
      )
      .handle("list", ({ query }) => {
        const options = listOptions(query)
        const sort = options.sort ?? "activity"
        const limit = options.limit ?? 100
        return store.list({ ...options, limit: limit + 1 }).pipe(
          Effect.map((rows) => {
            const sessions = rows.slice(0, limit)
            const last = sessions.at(-1)
            return {
              sessions: sessions.map(listedSessionToWire),
              next_cursor:
                rows.length > limit && last !== undefined ? sessionCursor(last, sort) : null
            }
          }),
          Effect.catch(failStore)
        )
      })
      .handle("create", ({ payload }) =>
        LocalCaller.pipe(
          Effect.flatMap((caller) =>
            creation({
              name: payload.name ?? undefined,
              spaceId: payload.space_id ?? undefined,
              chatModel: payload.chat_model ?? undefined,
              origin: payload.origin,
              ...(caller === "cli" ? { commandLine: true as const } : {})
            })
          ),
          Effect.tap((created) =>
            payload.origin === "onboarding" ? kickoff(created.sessionId) : Effect.void
          ),
          Effect.map(createdSessionToWire),
          Effect.catchTags({
            SessionStoreError: (error) => Effect.fail(storeErrorToHttp(error)),
            ModelStoreError: (error) => Effect.fail(storeErrorToHttp(error))
          })
        )
      )
      .handle("branch", ({ params, payload }) =>
        Effect.gen(function* () {
          const branched = yield* store.branch(params.sessionId, {
            name: payload.name ?? undefined,
            upToMessageId: payload.up_to_message_id ?? undefined,
            requestId: payload.request_id,
            shareResources: payload.share_resources,
            disposition: payload.disposition
          })
          if (branched === undefined) return yield* new HttpApiError.NotFound({})
          const ready = yield* forkPreparation.finishOrDiscard({
            sourceSessionId: params.sessionId,
            childSessionId: branched.sessionId
          })
          if (!ready) return yield* new HttpApiError.NotFound({})
          return branchedSessionToWire(branched)
        }).pipe(
          Effect.catchTags({
            SessionStoreError: (error) => Effect.fail(storeErrorToHttp(error)),
            ConversationArtifactError: (error) => Effect.fail(artifactHttpError(error))
          })
        )
      )
      .handle("archived", () =>
        store.listArchived().pipe(
          Effect.map((sessions) => ({ sessions: sessions.map(archivedSessionToWire) })),
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("rename", ({ params, payload }) =>
        store.rename(params.sessionId, payload.name).pipe(
          Effect.catch(failStore),
          Effect.flatMap(orNotFound),
          Effect.map((name) => ({ session_id: params.sessionId, name }))
        )
      )
      .handle("model", ({ params, payload }) =>
        Effect.gen(function* () {
          const selection = yield* models.setSessionModel(params.sessionId, payload.chat_model)
          const header = yield* sessions.loadHistoryHeader(params.sessionId)
          if (header === null) return yield* new HttpApiError.NotFound({})
          const budget = yield* models.contextBudget({
            modelId: selection.modelId,
            inputTokens: header.lastInputTokens ?? 0,
            messageCount: header.activeMessageCount
          })
          return {
            session_id: params.sessionId,
            chat_model: selection.overrideModelId,
            context_budget: budget
          }
        }).pipe(
          Effect.mapError((error) => {
            if (error instanceof ModelStoreError) return storeErrorToHttp(error)
            if (error instanceof HttpApiError.NotFound) return error
            return new HttpApiError.InternalServerError({})
          })
        )
      )
      .handle("move", ({ params, payload }) =>
        store.moveToSpace(params.sessionId, payload.space_id ?? undefined).pipe(
          Effect.catch(failStore),
          Effect.filterOrFail(
            (found) => found,
            () => new HttpApiError.NotFound({})
          ),
          Effect.map(() => ({ session_id: params.sessionId, space_id: payload.space_id }))
        )
      )
      .handle("exportSession", ({ params, query }) =>
        Effect.gen(function* () {
          const snapshot = yield* sessions.load(params.sessionId)
          if (snapshot === null) return yield* new HttpApiError.NotFound({})
          const records = yield* readSessionExportTranscript(transcript, params.sessionId)
          const exportedAt = DateTime.formatIso(yield* DateTime.now)
          return renderSessionExport(
            makeSessionExportModel(snapshot, records, exportedAt),
            query.format
          )
        }).pipe(
          Effect.mapError((error) =>
            error instanceof HttpApiError.NotFound
              ? error
              : new HttpApiError.InternalServerError({})
          )
        )
      )
      .handle("find", ({ params, query }) =>
        transcript.findInConversation(params.sessionId, query.q).pipe(
          Effect.map((found) => ({
            hits: found.hits.map((hit) => ({
              message_id: hit.messageId,
              seq: hit.sequence,
              count: hit.count
            })),
            truncated: found.truncated
          })),
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("search", ({ query }) =>
        transcript.searchChats({ query: query.q, limit: CHAT_SEARCH_LIMIT }).pipe(
          Effect.map((page) => ({
            hits: page.hits.map((hit) => ({
              session_id: hit.sessionId,
              session_name: hit.sessionName,
              message_id: hit.messageId,
              snippet: hit.snippet,
              ranges: hit.ranges,
              created_at: hit.createdAt
            })),
            has_more: page.hasMore
          })),
          Effect.mapError((error) =>
            error._tag === "TranscriptSearchError" && error.reason === "invalid"
              ? new HttpApiError.BadRequest({})
              : new HttpApiError.InternalServerError({})
          )
        )
      )
      .handle("triage", ({ params }) =>
        triage(params.sessionId).pipe(
          Effect.mapError((error) =>
            error instanceof StructuredCompletionError
              ? completionErrorToHttp(error)
              : new HttpApiError.InternalServerError({})
          ),
          Effect.flatMap(orNotFound)
        )
      )
      .handle("settleTriage", ({ params, payload }) =>
        settleTriage(params.sessionId, payload.action).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Triage action refused", {
              sessionId: params.sessionId,
              action: payload.action,
              error: error._tag,
              reason: "reason" in error ? error.reason : undefined,
              message: error.message
            })
          ),
          Effect.mapError(triageActionError),
          Effect.flatMap(orNotFound)
        )
      )
      .handle(
        "visualizations",
        Effect.fn("SessionHandlers.visualizations")(function* ({ params }) {
          const lineage = yield* artifactLineage(params.sessionId)
          const root = lineage?.at(-1)
          if (root === undefined) return yield* new HttpApiError.NotFound({})
          const manifests = yield* artifacts.list(root).pipe(Effect.mapError(artifactHttpError))
          const turns = yield* runs
            .turnsOfRuns(manifests.flatMap((manifest) => manifest.producer_run_id ?? []))
            .pipe(
              Effect.tapError((error) =>
                Effect.logError("Output turns failed", { sessionId: params.sessionId, error })
              ),
              Effect.orElseSucceed(() => new Map<string, string>())
            )
          return manifests.map((manifest) =>
            visualizationToWire(
              manifest,
              manifest.producer_run_id === undefined
                ? undefined
                : turns.get(manifest.producer_run_id)
            )
          )
        })
      )
      .handle(
        "visualization",
        Effect.fn("SessionHandlers.visualization")(function* ({ params }) {
          const lineage = yield* artifactLineage(params.sessionId)
          if (lineage === null) return yield* new HttpApiError.NotFound({})
          const { manifest } = yield* readInLineage(lineage, params.artifactRef)
          return visualizationToWire(manifest)
        })
      )
      .handle(
        "visualizationContent",
        Effect.fn("SessionHandlers.visualizationContent")(function* ({ params }) {
          const lineage = yield* artifactLineage(params.sessionId)
          if (lineage === null) return yield* new HttpApiError.NotFound({})
          const { manifest, bytes } = yield* readInLineage(lineage, params.artifactRef)
          return HttpApiSchema.withHeaders({
            body: bytes,
            headers: { "content-type": manifest.media_type }
          })
        })
      )
      .handle("archive", ({ params, query }) =>
        endChat(params.sessionId, "archive", query.stop).pipe(
          Effect.as({ status: "archived" as const, session_id: params.sessionId })
        )
      )
      .handle("restore", ({ params }) =>
        store.restore(params.sessionId).pipe(
          Effect.catch(failStore),
          Effect.filterOrFail(
            (found) => found,
            () => new HttpApiError.NotFound({})
          ),
          Effect.map(() => ({ status: "restored" as const, session_id: params.sessionId }))
        )
      )
      .handle("continueRun", ({ params }) =>
        store.continueRun(params.sessionId).pipe(
          Effect.catch(failStore),
          Effect.filterOrFail(
            (found) => found,
            () => new HttpApiError.NotFound({})
          ),
          Effect.map(() => ({ status: "continued" as const, session_id: params.sessionId }))
        )
      )
      .handle(
        "permanentDelete",
        Effect.fn("SessionHandlers.permanentDelete")(function* ({ params, query }) {
          yield* endChat(params.sessionId, "delete", query.stop)
          yield* fileCleanup.drainAfterDelete()
          return { status: "deleted" as const, session_id: params.sessionId }
        })
      )
      .handle("read", ({ params }) =>
        readState.mark(params.sessionId).pipe(
          Effect.mapError(readError),
          Effect.flatMap(orNotFound),
          Effect.tap(() => memory.prepare()),
          Effect.map((marked) => ({
            session_id: params.sessionId,
            has_unread: marked.hasUnread
          }))
        )
      )
  })
)
