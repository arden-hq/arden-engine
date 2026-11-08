import { Effect } from "effect"

import { PROMPT_TEXT } from "../prompts/catalog.js"
import { cutText } from "@arden-hq/std/text"
import type { StructuredCompletion } from "../models/structured-completion.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import type { SpaceStore } from "../persistence/spaces/store.js"

const LETTER_SUBJECT_INPUT_MAX_CHARS = 8_000

export interface LetterSubjectInput {
  readonly sessionId: string
  readonly messageId: string
  readonly text: string
  readonly signal?: AbortSignal
}

export interface LetterSubjectDependencies {
  readonly completion: StructuredCompletion["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly spaces: SpaceStore["Service"]
}

export const makeLetterSubject = (dependencies: LetterSubjectDependencies) =>
  Effect.fn("LetterSubject.generate")(function* (input: LetterSubjectInput) {
    const text = input.text.trim()
    if (text.length === 0) return false
    const header = yield* dependencies.sessions.loadHistoryHeader(input.sessionId)
    if (header === null || header.spaceId === null || header.sessionType === "agent") return false

    const subject = yield* dependencies.completion.runText({
      role: "helper",
      usage: { kind: "letter_subject", owner: { type: "session", sessionId: input.sessionId } },
      system: PROMPT_TEXT.letterSubject,
      user: JSON.stringify({ message: cutText(text, LETTER_SUBJECT_INPUT_MAX_CHARS) }),
      maxOutputTokens: 80,
      maxCharacters: 120,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
    yield* dependencies.spaces.recordLetterSubject(input.sessionId, input.messageId, subject)
    return true
  })
