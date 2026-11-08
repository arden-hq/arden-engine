import { Effect } from "effect"

import type { SpaceStoreError } from "../persistence/spaces/store.js"
import type { SessionHistoryHeader } from "../persistence/sessions/model.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import type { Wiki } from "../wiki/service.js"

export interface DiscussedChat {
  readonly name: string
  readonly publicRef: string
  readonly savedAt: string | undefined
  readonly otherSpace: string | undefined
}

export const citedChatRefs = (body: string): ReadonlyArray<string> => [
  ...new Set(body.match(/\b[a-z0-9][a-z0-9-]*~[a-z0-9]{5,8}\b/gu) ?? [])
]

type Sessions = Pick<SessionQueries["Service"], "loadHistoryHeader" | "sessionIdForRef">

interface PageSource {
  readonly sessionId: string
  readonly savedAt: string | undefined
}

const pageSources = Effect.fn("Memory.pageSources")(function* (
  sessions: Sessions,
  saves: ReadonlyArray<{ readonly sessionId: string; readonly savedAt: string }>,
  cited: ReadonlyArray<string>
) {
  const sources: PageSource[] = [...saves]
  for (const ref of cited) {
    const sessionId = yield* sessions.sessionIdForRef(ref)
    if (sessionId !== null) sources.push({ sessionId, savedAt: undefined })
  }
  return sources
})

const CHATS_PER_PAGE = 3
const PAGE_VIEW_CHATS = 12
const PARENT_HOPS = 3

const userChats = (sessions: Sessions) => {
  const resolved = new Map<string, SessionHistoryHeader | null>()
  return Effect.fn("Memory.userChat")(function* (sessionId: string) {
    if (resolved.has(sessionId)) return resolved.get(sessionId) ?? null
    let header = yield* sessions.loadHistoryHeader(sessionId)
    for (let hop = 0; hop < PARENT_HOPS && header?.sessionType === "agent"; hop += 1) {
      header =
        header.parentSessionId === null
          ? null
          : yield* sessions.loadHistoryHeader(header.parentSessionId)
    }
    const chat =
      header === null ||
      header.sessionType === "agent" ||
      (header.originAutomationId !== null && !header.originAutomationId.startsWith("space:"))
        ? null
        : header
    resolved.set(sessionId, chat)
    return chat
  })
}

const spaceNames = (
  spaceName: (spaceId: string) => Effect.Effect<string | undefined, SpaceStoreError>
) => {
  const names = new Map<string, string | undefined>()
  return Effect.fn("Memory.spaceName")(function* (spaceId: string) {
    if (!names.has(spaceId)) names.set(spaceId, yield* spaceName(spaceId))
    return names.get(spaceId)
  })
}

export const discussedIn = Effect.fn("Memory.discussedIn")(function* (input: {
  readonly wiki: Pick<Wiki["Service"], "pageChats">
  readonly sessions: Sessions
  readonly spaceName: (spaceId: string) => Effect.Effect<string | undefined, SpaceStoreError>
  readonly sessionId: string
  readonly cited: ReadonlyMap<string, ReadonlyArray<string>>
}) {
  const current = yield* input.sessions.loadHistoryHeader(input.sessionId)
  if (current === null) return new Map<string, ReadonlyArray<DiscussedChat>>()
  const pageChats = yield* input.wiki.pageChats([...input.cited.keys()])
  const userChat = userChats(input.sessions)
  const spaceName = spaceNames(input.spaceName)
  const discussed = new Map<string, ReadonlyArray<DiscussedChat>>()
  for (const pageId of input.cited.keys()) {
    const named: DiscussedChat[] = []
    const sources = yield* pageSources(
      input.sessions,
      pageChats.get(pageId) ?? [],
      input.cited.get(pageId) ?? []
    )
    for (const saved of sources) {
      if (named.length === CHATS_PER_PAGE) break
      const chat = yield* userChat(saved.sessionId)
      if (
        chat === null ||
        chat.sessionId === current.sessionId ||
        named.some((known) => known.publicRef === chat.publicRef)
      ) {
        continue
      }
      named.push({
        name: chat.name ?? "Untitled chat",
        publicRef: chat.publicRef,
        savedAt: saved.savedAt,
        otherSpace:
          chat.spaceId === null || chat.spaceId === current.spaceId
            ? undefined
            : yield* spaceName(chat.spaceId)
      })
    }
    if (named.length > 0) discussed.set(pageId, named)
  }
  return discussed
})

export const pageCameFrom = Effect.fn("Memory.pageCameFrom")(function* (input: {
  readonly wiki: Pick<Wiki["Service"], "pageChats">
  readonly sessions: Sessions
  readonly spaceName: (spaceId: string) => Effect.Effect<string | undefined, SpaceStoreError>
  readonly pageId: string
  readonly body: string
}) {
  const saves = yield* pageSources(
    input.sessions,
    (yield* input.wiki.pageChats([input.pageId])).get(input.pageId) ?? [],
    citedChatRefs(input.body)
  )
  const userChat = userChats(input.sessions)
  const spaceName = spaceNames(input.spaceName)
  const chats: Array<{
    readonly sessionId: string
    readonly sessionRef: string
    readonly name: string | null
    readonly spaceId: string | null
    readonly spaceName: string | null
    readonly savedAt: string | null
  }> = []
  for (const saved of saves) {
    if (chats.length === PAGE_VIEW_CHATS) break
    const chat = yield* userChat(saved.sessionId)
    if (chat === null || chats.some((known) => known.sessionRef === chat.publicRef)) continue
    const chatSpaceName = chat.spaceId === null ? null : ((yield* spaceName(chat.spaceId)) ?? null)
    chats.push({
      sessionId: chat.sessionId,
      sessionRef: chat.publicRef,
      name: chat.name,
      spaceId: chatSpaceName === null ? null : chat.spaceId,
      spaceName: chatSpaceName,
      savedAt: saved.savedAt ?? null
    })
  }
  return chats
})
