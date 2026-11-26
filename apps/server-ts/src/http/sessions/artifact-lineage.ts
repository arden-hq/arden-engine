import { CONVERSATION_ERROR_REASON } from "../../artifacts/conversation-model.js"
import { Effect } from "effect"
import { SessionQueries } from "../../persistence/sessions/queries.js"
import { failInternal } from "../errors.js"
import { ConversationArtifacts } from "../../artifacts/conversation.js"
import { sessionLineage } from "../../persistence/sessions/lineage.js"
import { artifactHttpError, type SessionHttpError } from "./handler-errors.js"
import { HttpApiError } from "effect/unstable/httpapi"
import { type ConversationArtifact } from "../../artifacts/conversation-model.js"

export interface ArtifactReads {
  readonly artifactLineage: (
    sessionId: string
  ) => Effect.Effect<ReadonlyArray<string> | null, HttpApiError.InternalServerError>
  readonly readInLineage: (
    lineage: ReadonlyArray<string>,
    ref: string
  ) => Effect.Effect<ConversationArtifact, SessionHttpError>
}

export const makeArtifactReads = ({
  sessions,
  artifacts
}: {
  readonly sessions: SessionQueries["Service"]
  readonly artifacts: ConversationArtifacts["Service"]
}): ArtifactReads => {
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
              (error) => error.reason === CONVERSATION_ERROR_REASON.notFound,
              () => artifacts.read(owner, ref)
            )
          ),
        artifacts.read(lineage[0] ?? "", ref)
      )
      .pipe(Effect.mapError(artifactHttpError))
  return { artifactLineage, readInLineage }
}
