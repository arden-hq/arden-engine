import { listOptions, targetSessionId } from "./list-query.js"
import {
  BRANCH_REQUEST,
  CLEARED,
  PARENT_MESSAGE,
  REVERT_TO,
  RUNNING_WORK,
  SEARCH_PREVIEW,
  SESSION_LIST_NEXT,
  SESSION_ORIGIN,
  type SessionListSort
} from "@arden-hq/protocol/sessions"
import {
  modelIdOf,
  nameText,
  sessionChatModel,
  sessionName,
  sessionSpace,
  spaceIdOf
} from "../../sessions/session-states.js"
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
  type SessionListEntry
} from "../../persistence/sessions/store.js"
import { TranscriptQueries, type ChatSearchHit } from "../../persistence/transcript/queries.js"
import {
  makeSessionExportModel,
  readSessionExportTranscript,
  renderSessionExport
} from "../../sessions/export.js"
import { makeSessionCreation } from "../../sessions/create.js"
import { ChatMessage } from "../../chat/message.js"
import { onboardingKickoff } from "../../chat/message-input.js"
import { makeOnboardingStart } from "../../chat/onboarding-start.js"
import {
  makeSessionTriage,
  makeSessionTriageAction,
  type SessionTriageConflict
} from "../../assist/session-triage.js"
import { ArdenApi } from "../api.js"
import {
  completionErrorToHttp,
  failInternal,
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
import { ConversationArtifactError, ConversationArtifacts } from "../../artifacts/conversation.js"
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
import { Wiki } from "../../wiki/service.js"
import { NO_TURNS, visualizationToWire } from "./visualization-wire.js"

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
        ? { detail: error.message, running: { kind: RUNNING_WORK.none } }
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

/** Chats whose messages match that a find across all chats returns. The panel shows
 * about eight; the rest scroll, and `has_more` says there are more. */
const CHAT_SEARCH_LIMIT = 20

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
        .pipe(Effect.catch(failInternal("Sessions")))
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
    const startOnboarding = yield* makeOnboardingStart({ store, send: chat.send })
    const kickoff = (sessionId: string) =>
      chat.send(onboardingKickoff(sessionId)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Onboarding chat opened without Arden's first message", {
            sessionId,
            cause
          })
        )
      )
    const wiki = yield* Wiki
    const triage = makeSessionTriage({ completion, sessions, spaces, store, wiki })
    const settleTriage = makeSessionTriageAction({ completion, sessions, spaces, store, wiki })
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
      stop: boolean | "true" | "false"
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
            running: { kind: RUNNING_WORK.running, work: ended.running }
          })
      }
    })

    return handlers
      .handle("browserScope", ({ payload }) =>
        sessions.browserScope(payload).pipe(
          Effect.catch(failInternal("Sessions")),
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
        store.clear(targetSessionId(payload.target)).pipe(
          Effect.map((sessionId) => ({
            status: "cleared" as const,
            cleared:
              sessionId === undefined
                ? { kind: CLEARED.none }
                : { kind: CLEARED.session, session_id: sessionId }
          })),
          Effect.mapError(storeErrorToHttp)
        )
      )
      .handle("revert", ({ payload }) =>
        store
          .revert({
            sessionId: targetSessionId(payload.target),
            ...(payload.to.kind === REVERT_TO.turns
              ? { turns: payload.to.turns }
              : { messageId: payload.to.message_id })
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
        const { sort, limit } = query
        return store.list({ ...listOptions(query), limit: limit + 1 }).pipe(
          Effect.map((rows) => {
            const sessions = rows.slice(0, limit)
            const last = sessions.at(-1)
            return {
              sessions: sessions.map(listedSessionToWire),
              next:
                rows.length > limit && last !== undefined
                  ? { kind: SESSION_LIST_NEXT.more, cursor: sessionCursor(last, sort) }
                  : { kind: SESSION_LIST_NEXT.end }
            }
          }),
          Effect.catch(failStore)
        )
      })
      .handle("create", ({ payload }) =>
        LocalCaller.pipe(
          Effect.flatMap((caller) =>
            creation({
              name: nameText(payload.name) ?? undefined,
              spaceId: spaceIdOf(payload.space) ?? undefined,
              chatModel: modelIdOf(payload.chat_model) ?? undefined,
              origin: payload.origin === SESSION_ORIGIN.ordinary ? undefined : payload.origin,
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
            name: nameText(payload.name) ?? undefined,
            upToMessageId:
              payload.up_to.kind === PARENT_MESSAGE.message ? payload.up_to.message_id : undefined,
            requestId:
              payload.request.kind === BRANCH_REQUEST.keyed
                ? payload.request.request_id
                : undefined,
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
          Effect.catch(failInternal("Sessions"))
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
          const selection = yield* models.setSessionModel(
            params.sessionId,
            modelIdOf(payload.chat_model)
          )
          const header = yield* sessions.loadHistoryHeader(params.sessionId)
          if (header === null) return yield* new HttpApiError.NotFound({})
          const budget = yield* models.contextBudget({
            modelId: selection.modelId,
            inputTokens: header.lastInputTokens ?? 0,
            messageCount: header.activeMessageCount
          })
          return {
            session_id: params.sessionId,
            chat_model: sessionChatModel(selection.overrideModelId),
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
        store.moveToSpace(params.sessionId, spaceIdOf(payload.space) ?? undefined).pipe(
          Effect.catch(failStore),
          Effect.flatMap((spaceId) =>
            spaceId === undefined
              ? Effect.fail(new HttpApiError.NotFound({}))
              : Effect.succeed({ session_id: params.sessionId, space: sessionSpace(spaceId) })
          )
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
          Effect.catch(failInternal("Sessions"))
        )
      )
      .handle("search", ({ query }) =>
        transcript.searchChats({ query: query.q, limit: CHAT_SEARCH_LIMIT }).pipe(
          Effect.map((page) => ({
            chats: page.chats.map((chat) => {
              const base = {
                session_id: chat.sessionId,
                session_name: sessionName(chat.sessionName),
                name_ranges: chat.nameRanges,
                last_activity: chat.lastActivity
              }
              const line = (hit: ChatSearchHit) => ({
                message_id: hit.messageId,
                snippet: hit.snippet,
                ranges: hit.ranges,
                created_at: hit.createdAt
              })
              return chat.match === "message"
                ? { ...base, match: "message" as const, hit: line(chat.hit) }
                : {
                    ...base,
                    match: "name" as const,
                    preview:
                      chat.preview === undefined
                        ? { kind: SEARCH_PREVIEW.none }
                        : { kind: SEARCH_PREVIEW.message, hit: line(chat.preview) }
                  }
            }),
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
          return manifests.map((manifest) => visualizationToWire(manifest, turns))
        })
      )
      .handle(
        "visualization",
        Effect.fn("SessionHandlers.visualization")(function* ({ params }) {
          const lineage = yield* artifactLineage(params.sessionId)
          if (lineage === null) return yield* new HttpApiError.NotFound({})
          const { manifest } = yield* readInLineage(lineage, params.artifactRef)
          return visualizationToWire(manifest, NO_TURNS)
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
      .handle("startOnboarding", ({ params }) =>
        startOnboarding(params.sessionId).pipe(
          Effect.map((started) => ({ session_id: params.sessionId, started })),
          Effect.catchTags({
            SessionStoreError: failStore,
            ChatMessageConflictError: (error) =>
              Effect.fail(new StoreConflict({ detail: error.message })),
            ChatMessageError: (error) =>
              error.reason === "not_found"
                ? Effect.fail(new HttpApiError.NotFound({}))
                : failInternal("Sessions")(error)
          })
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
