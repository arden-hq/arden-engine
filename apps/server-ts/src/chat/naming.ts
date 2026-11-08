import { Effect } from "effect"
import { splitAttachedFiles } from "@arden-hq/protocol/chat"

import { PROMPT_TEXT } from "../prompts/catalog.js"
import { cutText } from "@arden-hq/std/text"
import type { StructuredCompletion } from "../models/structured-completion.js"
import type { SessionNameImage } from "../persistence/sessions/model.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import type { SessionStore } from "../persistence/sessions/store.js"

const SESSION_NAMING_INPUT_MAX_CHARS = 8_000
const SESSION_NAMING_MAX_IMAGES = 1

export interface SessionNamingInput {
  readonly sessionId: string
  readonly text: string
  readonly images: ReadonlyArray<SessionNameImage>
  readonly signal?: AbortSignal
}

export interface SessionNamingDependencies {
  readonly completion: StructuredCompletion["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly store: SessionStore["Service"]
}

export const makeSessionNaming = (dependencies: SessionNamingDependencies) =>
  Effect.fn("SessionNaming.generate")(function* (input: SessionNamingInput) {
    const header = yield* dependencies.sessions.loadHistoryHeader(input.sessionId)
    if (
      header === null ||
      header.sessionType !== "chat" ||
      header.originAutomationId !== null ||
      (header.name?.trim().length ?? 0) > 0
    )
      return false
    const seed = (yield* dependencies.sessions.loadNameSeed(input.sessionId)) ?? input
    if (seed.text.trim().length === 0 && seed.images.length === 0) return false

    const sent = splitAttachedFiles(seed.text)
    const trimmedSeed = sent.text.trim()
    const firstMessage =
      trimmedSeed.length === 0 ? null : cutText(trimmedSeed, SESSION_NAMING_INPUT_MAX_CHARS)
    const images = seed.images.slice(0, SESSION_NAMING_MAX_IMAGES)
    const name = yield* dependencies.completion.runText({
      role: "helper",
      usage: { kind: "chat_title", owner: { type: "session", sessionId: input.sessionId } },
      system: PROMPT_TEXT.sessionNaming,
      user: JSON.stringify({
        first_user_message: firstMessage,
        ...(sent.files.length === 0 ? {} : { attached_files: sent.files.map((file) => file.name) }),
        has_images: seed.images.length > 0
      }),
      ...(images.length === 0 ? {} : { images }),
      maxOutputTokens: 80,
      maxCharacters: 80,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
    return yield* dependencies.store.renameIfEmpty(input.sessionId, name)
  })
