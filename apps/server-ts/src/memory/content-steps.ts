import { DateTime, Effect } from "effect"

import type { SessionQueries, SessionQueryFailure } from "../persistence/sessions/queries.js"
import type {
  TranscriptQueries,
  TranscriptQueryFailure
} from "../persistence/transcript/queries.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import type { Wiki } from "../wiki/service.js"
import { pathAliasRedirects } from "../wiki/alias-redirects.js"
import type { WikiContentStep } from "../wiki/content-steps.js"
import { chatPointers, rewriteChatCitations, type CitedChat } from "./chat-citations.js"

type Sessions = Pick<SessionQueries["Service"], "sessionIdForRef" | "loadHistoryHeader">
type Transcript = Pick<TranscriptQueries["Service"], "page">

const sentAt = Effect.fn("Memory.citedMessageSentAt")(function* (
  transcript: Transcript,
  sessionId: string,
  sequence: number
) {
  const page = yield* transcript.page({
    _tag: "After",
    sessionId,
    sequence: sequence - 1,
    limit: 1
  })
  const record = page.records[0]
  return record?.sequence === sequence ? DateTime.toDate(record.createdAt) : undefined
})

const resolveCitedChats = Effect.fn("Memory.resolveCitedChats")(function* (
  sessions: Sessions,
  transcript: Transcript,
  bodies: ReadonlyArray<string>
) {
  const wanted = new Map<string, Set<number>>()
  for (const pointer of bodies.flatMap(chatPointers)) {
    const sequences = wanted.get(pointer.publicRef) ?? new Set<number>()
    for (const sequence of pointer.sequences) sequences.add(sequence)
    wanted.set(pointer.publicRef, sequences)
  }
  const chats = new Map<string, CitedChat>()
  for (const [publicRef, sequences] of wanted) {
    const sessionId = yield* sessions.sessionIdForRef(publicRef)
    const header = sessionId === null ? null : yield* sessions.loadHistoryHeader(sessionId)
    if (header === null) continue
    const sent = new Map<number, Date>()
    for (const sequence of sequences) {
      const at = yield* sentAt(transcript, header.sessionId, sequence)
      if (at !== undefined) sent.set(sequence, at)
    }
    chats.set(publicRef, { publicRef, title: header.name ?? "", sentAt: sent })
  }
  return chats
})

const chatCitationLinks = (
  sessions: Sessions,
  transcript: Transcript,
  now: Date
): WikiContentStep<SessionQueryFailure | TranscriptQueryFailure> => ({
  name: "0001_chat_citation_links",
  reason: "Cite chats by title and date",
  rewrite: (pages) =>
    resolveCitedChats(
      sessions,
      transcript,
      pages.map((page) => page.body)
    ).pipe(
      Effect.map((chats) => ({
        pages: pages.map((page) => ({
          ...page,
          body: rewriteChatCitations(page.body, chats, now)
        })),
        redirects: []
      }))
    )
})

export const startMemoryContentSteps = Effect.fn("Memory.startContentSteps")(function* (input: {
  readonly wiki: Pick<Wiki["Service"], "applyContentStep">
  readonly sessions: Sessions
  readonly transcript: Transcript
}) {
  const lifecycle = yield* ServerLifecycle
  yield* lifecycle.background(
    runMemoryContentSteps(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Memory content steps wait for the next start", cause)
      )
    )
  )
})

const runMemoryContentSteps = Effect.fn("Memory.runContentSteps")(function* (input: {
  readonly wiki: Pick<Wiki["Service"], "applyContentStep">
  readonly sessions: Sessions
  readonly transcript: Transcript
}) {
  const now = yield* DateTime.now
  const steps = [
    chatCitationLinks(input.sessions, input.transcript, DateTime.toDate(now)),
    pathAliasRedirects
  ]
  for (const step of steps) {
    const result = yield* input.wiki.applyContentStep(step)
    if (result.kind === "applied" && result.changedPaths.length > 0) {
      yield* Effect.logInfo(
        `Memory content step ${step.name} rewrote ${result.changedPaths.length} pages`
      )
    }
  }
})
