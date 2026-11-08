import type {
  SessionTriageAction,
  SessionTriageDecision,
  SessionTriageTarget
} from "@arden-hq/protocol/sessions"
import { DateTime, Effect, Schema } from "effect"

import {
  type StructuredCompletion,
  StructuredCompletionError
} from "../models/structured-completion.js"
import { isKeepOneSpace, type SpaceStore } from "../persistence/spaces/store.js"
import type { ActiveSessionSnapshot, SessionHeaderSnapshot } from "../persistence/sessions/model.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import { type SessionStore, SessionStoreError } from "../persistence/sessions/store.js"
import {
  freshTriage,
  NO_TRIAGE,
  StoredTriageSchema,
  type StoredTriage
} from "../persistence/sessions/triage.js"
import { type StoredMessageEnvelope, visibleMessageCount } from "../persistence/transcript/model.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import { conversationLine, newestWithinBudget } from "./conversation.js"

const TRIAGE_MESSAGE_MAX_CHARS = 4_000
const TRIAGE_TRANSCRIPT_MAX_CHARS = 24_000
const TRIAGE_TITLE_MAX_CHARS = 200

export interface SessionTriageDependencies {
  readonly completion: Pick<StructuredCompletion["Service"], "runTool">
  readonly sessions: Pick<SessionQueries["Service"], "load" | "loadHeaderSnapshot" | "blockingWork">
  readonly spaces: Pick<SpaceStore["Service"], "list" | "create" | "archive">
  readonly store: Pick<
    SessionStore["Service"],
    "moveToSpace" | "saveTriage" | "adoptSpaceConversation" | "releaseSpaceConversation"
  >
  readonly zone?: DateTime.TimeZone
}

export class SessionTriageConflict extends Schema.TaggedError<SessionTriageConflict>()(
  "SessionTriageConflict",
  { reason: Schema.Literals(["stale", "busy"] as const), message: Schema.String }
) {}

const staleSuggestion = (message = "This suggestion no longer applies") =>
  new SessionTriageConflict({ reason: "stale", message })

const BUSY_MESSAGE = "Arden is still working in this Chat. File it once the work is done."

export const makeSessionTriage = (dependencies: SessionTriageDependencies) =>
  Effect.fn("SessionTriage.decide")(function* (sessionId: string) {
    const session = yield* dependencies.sessions.load(sessionId)
    if (session === null) return undefined
    if (!looseChat(session)) return NO_TRIAGE

    const fresh = freshTriage(yield* storedTriage(session), chatState(session), dependencies.zone)
    if (fresh !== undefined) return fresh
    if (!session.messages.some((message) => message.role === "assistant")) return NO_TRIAGE
    if (yield* dependencies.sessions.blockingWork(sessionId)) return NO_TRIAGE

    const transcript = triageTranscript(session.messages)
    if (transcript.length === 0) return NO_TRIAGE

    const candidates = (yield* dependencies.spaces.list()).map((space): SessionTriageTarget => ({
      space_id: space.space_id,
      title: space.name
    }))
    const output = yield* dependencies.completion.runTool({
      role: "helper",
      usage: { kind: "chat_triage", owner: { type: "session", sessionId } },
      system: PROMPT_TEXT.sessionTriage,
      user: JSON.stringify({ conversation: transcript, spaces: candidates }),
      result: {
        schema: TriageOutputSchema,
        name: "triage_session",
        displayName: "Triage Chat",
        description:
          "Submit the single final filing decision for this Chat. Call this exactly once after considering the conversation and supplied Space catalog."
      },
      maxOutputTokens: 256
    })
    const decision = yield* validatedTriageDecision(output, candidates)
    const checked = {
      decision,
      checked_at: DateTime.formatIso(yield* DateTime.now),
      checked_count: visibleMessageCount(session.messages)
    }

    if (decision.decision === "move" && output.confident) {
      const moved = yield* dependencies.store
        .moveToSpace(sessionId, decision.target.space_id)
        .pipe(Effect.catchTag("SessionStoreError", () => Effect.succeed(false)))
      if (moved) {
        yield* dependencies.store.saveTriage(sessionId, {
          outcome: "filed",
          ...checked,
          filed: {
            space_id: decision.target.space_id,
            title: decision.target.title,
            created: false
          }
        })
        return movedTo(decision.target, decision.rationale)
      }
    }
    yield* dependencies.store.saveTriage(sessionId, { outcome: "suggested", ...checked })
    return decision
  })

export const makeSessionTriageAction = (dependencies: SessionTriageDependencies) =>
  Effect.fn("SessionTriage.act")(function* (sessionId: string, action: SessionTriageAction) {
    const session = yield* dependencies.sessions.loadHeaderSnapshot(sessionId)
    if (session === null) return undefined
    const stored = yield* storedTriage(session)
    if (stored === undefined) return yield* staleSuggestion("This Chat has no filing suggestion")

    switch (action) {
      case "dismiss": {
        if (stored.outcome !== "suggested" && stored.outcome !== "dismissed") {
          return yield* staleSuggestion("Only a suggestion can be dismissed")
        }
        yield* dependencies.store.saveTriage(sessionId, { ...stored, outcome: "dismissed" })
        return NO_TRIAGE
      }
      case "accept": {
        if (stored.outcome !== "suggested" || !looseChat(session)) {
          return yield* staleSuggestion()
        }
        if (yield* dependencies.sessions.blockingWork(sessionId)) {
          return yield* new SessionTriageConflict({ reason: "busy", message: BUSY_MESSAGE })
        }
        const filed = yield* fileChat(dependencies, sessionId, stored.decision).pipe(
          Effect.catchTag("SessionTriageConflict", (conflict) =>
            conflict.reason === "stale"
              ? dependencies.store
                  .saveTriage(sessionId, { ...stored, outcome: "dismissed" })
                  .pipe(Effect.andThen(Effect.fail(conflict)))
              : Effect.fail(conflict)
          )
        )
        yield* dependencies.store.saveTriage(sessionId, {
          outcome: "filed",
          decision: stored.decision,
          checked_at: stored.checked_at,
          checked_count: stored.checked_count,
          filed
        })
        return movedTo({ space_id: filed.space_id, title: filed.title }, stored.decision.rationale)
      }
      case "undo": {
        if (stored.outcome !== "filed") {
          return yield* staleSuggestion("Triage did not file this Chat")
        }
        const { space_id: spaceId, created } = stored.filed
        if (created) yield* dependencies.store.releaseSpaceConversation(spaceId, sessionId)
        yield* requireMoved(yield* dependencies.store.moveToSpace(sessionId, undefined))
        if (created) yield* retireCreatedSpace(dependencies, spaceId)
        yield* dependencies.store.saveTriage(sessionId, { ...stored, outcome: "undone" })
        return NO_TRIAGE
      }
    }
  })

const retireCreatedSpace = (dependencies: SessionTriageDependencies, spaceId: string) =>
  dependencies.spaces.archive(spaceId).pipe(Effect.catchIf(isKeepOneSpace, () => Effect.void))

const fileChat = Effect.fn("SessionTriage.fileChat")(function* (
  dependencies: SessionTriageDependencies,
  sessionId: string,
  decision: SessionTriageDecision
) {
  switch (decision.decision) {
    case "move": {
      const target = decision.target
      const moved = yield* dependencies.store.moveToSpace(sessionId, target.space_id).pipe(
        Effect.catchIf(
          (error) => error.reason === "not_found",
          () => Effect.fail(staleSuggestion(`${target.title} is no longer a Space`))
        )
      )
      yield* requireMoved(moved)
      return { space_id: target.space_id, title: target.title, created: false }
    }
    case "create": {
      const space = yield* dependencies.spaces.create({ name: decision.new_title })
      yield* Effect.gen(function* () {
        yield* requireMoved(yield* dependencies.store.moveToSpace(sessionId, space.space_id))
        yield* dependencies.store.adoptSpaceConversation(space.space_id, sessionId)
      }).pipe(
        Effect.onError(() =>
          dependencies.store.moveToSpace(sessionId, undefined).pipe(
            Effect.andThen(retireCreatedSpace(dependencies, space.space_id)),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not take back a Space made for a failed filing", {
                sessionId,
                spaceId: space.space_id,
                cause
              })
            )
          )
        )
      )
      return { space_id: space.space_id, title: space.name, created: true }
    }
    case "none":
    case "moved":
      return yield* staleSuggestion()
  }
})

const requireMoved = (moved: boolean) =>
  moved ? Effect.void : Effect.fail(staleSuggestion("This Chat can no longer be filed"))

const movedTo = (target: SessionTriageTarget, rationale: string): SessionTriageDecision => ({
  decision: "moved",
  target,
  new_title: null,
  rationale
})

const looseChat = (session: SessionHeaderSnapshot): boolean =>
  session.header.spaceId === null &&
  session.header.sessionType === "chat" &&
  session.header.parentSessionId === null &&
  !Object.hasOwn(session.metadata, "capture") &&
  !Object.hasOwn(session.metadata, "onboarding")

const chatState = (session: ActiveSessionSnapshot) => ({
  messageCount: visibleMessageCount(session.messages),
  lastActivity: DateTime.formatIso(session.header.lastActivity)
})

const storedTriage = (
  session: SessionHeaderSnapshot
): Effect.Effect<StoredTriage | undefined, SessionStoreError> => {
  const stored = session.metadata["triage"]
  return stored === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(StoredTriageSchema)(stored).pipe(
        Effect.mapError(
          (cause) =>
            new SessionStoreError({
              operation: "triage",
              reason: "storage",
              message: "Stored triage decision is corrupt",
              sessionId: session.header.sessionId,
              cause
            })
        )
      )
}

const invalidOutput = (message: string) =>
  new StructuredCompletionError({ reason: "invalid_output", message })

const triageTranscript = (messages: ReadonlyArray<StoredMessageEnvelope>): string =>
  newestWithinBudget(
    messages.slice(-12).flatMap((message) => conversationLine(message, TRIAGE_MESSAGE_MAX_CHARS)),
    TRIAGE_TRANSCRIPT_MAX_CHARS
  )

const TriageOutputSchema = Schema.Struct({
  decision: Schema.Literals(["move", "create", "none"] as const),
  target: Schema.NullOr(
    Schema.Struct({
      space_id: Schema.String,
      title: Schema.String
    })
  ),
  new_title: Schema.NullOr(Schema.String),
  confident: Schema.Boolean,
  rationale: Schema.String
})

const validatedTriageDecision = (
  decision: typeof TriageOutputSchema.Type,
  candidates: ReadonlyArray<SessionTriageTarget>
): Effect.Effect<SessionTriageDecision, StructuredCompletionError> => {
  switch (decision.decision) {
    case "move": {
      const target =
        decision.target === null
          ? undefined
          : candidates.find((candidate) => candidate.space_id === decision.target?.space_id)
      return target === undefined
        ? Effect.fail(invalidOutput("The triage decision names a Space that does not exist"))
        : Effect.succeed({
            decision: "move" as const,
            target,
            new_title: null,
            rationale: decision.rationale
          })
    }
    case "create": {
      const title = decision.new_title?.trim()
      return title === undefined || title.length === 0
        ? Effect.fail(invalidOutput("The triage decision creates a Space without a title"))
        : Effect.succeed({
            decision: "create" as const,
            target: null,
            new_title: title.slice(0, TRIAGE_TITLE_MAX_CHARS),
            rationale: decision.rationale
          })
    }
    case "none":
      return Effect.succeed({ ...NO_TRIAGE, rationale: decision.rationale })
  }
}
