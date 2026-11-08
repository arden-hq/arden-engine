import { Effect } from "effect"

import type { ModelStore } from "../persistence/models/store.js"
import type { NewSession, SessionStore } from "../persistence/sessions/store.js"

export interface SessionCreationDependencies {
  readonly store: SessionStore["Service"]
  readonly models: ModelStore["Service"]
}

export const makeSessionCreation = (dependencies: SessionCreationDependencies) =>
  Effect.fn("SessionCreation.create")(function* (
    session: NewSession & { readonly chatModel?: string | undefined }
  ) {
    const chatModel = session.chatModel
    const created = yield* dependencies.store.create({
      name: session.name,
      spaceId: session.spaceId,
      origin: session.origin,
      commandLine: session.commandLine
    })
    if (chatModel === undefined) return created
    const selection = yield* dependencies.models
      .setSessionModel(created.sessionId, chatModel)
      .pipe(
        Effect.tapError(() =>
          dependencies.store
            .archive(created.sessionId)
            .pipe(
              Effect.andThen(dependencies.store.permanentDelete(created.sessionId)),
              Effect.ignore
            )
        )
      )
    return { ...created, chatModel: selection.overrideModelId ?? undefined }
  })
