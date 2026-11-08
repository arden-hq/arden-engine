import type { SpaceTask } from "@arden-hq/protocol/spaces/work"
import type { SpaceSummary } from "@arden-hq/protocol/spaces"
import type { HistoryMessage, HistoryResponse, TurnWorkResponse } from "@arden-hq/protocol/chat"
import type { MobileAsk } from "@arden-hq/protocol/mobile"
import type { RunApproval, RunQuestion } from "@arden-hq/protocol/runs"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import type { SessionListItem } from "@arden-hq/protocol/sessions"
import { chatName } from "@arden-hq/protocol/views"
import { DateTime, Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { addressedHomeLetter } from "../../automations/home-letter-links.js"
import { ChatHistory } from "../../chat/history.js"
import {
  ChatHistoryInvalidCursor,
  ChatSessionNotFound,
  ChatTurnNotFound
} from "../../chat/history-errors.js"
import { mobileAsks, type AskPlace } from "../../mobile/asks.js"
import { conversationLookupKeys, conversationPage } from "../../mobile/conversation.js"
import { isSpaceHome, looseChats, mobileSpace } from "../../mobile/spaces.js"
import { letterLookupKeys, mobileLetter, type PhoneHome } from "../../mobile/letter.js"
import { turnRail } from "../../mobile/turn.js"
import { AnswerBlockStore } from "../../persistence/answer-blocks/store.js"
import { SpaceStore } from "../../persistence/spaces/store.js"
import { HomeStore } from "../../persistence/home/store.js"
import { InboxStore } from "../../persistence/inbox/store.js"
import { RunQueries } from "../../persistence/runs/queries.js"
import { SessionLifecycleEvents } from "../../persistence/sessions/events.js"
import { SessionStore, type SessionListQuery } from "../../persistence/sessions/store.js"
import type { JsonObject } from "../../persistence/json.js"
import { WorkStore } from "../../persistence/work/store.js"
import { ArdenApi } from "../api.js"
import { listedSessionToWire } from "../wire/sessions.js"

const SPACE_CHAT_LIMIT = 50
const LOOSE_CHAT_LIMIT = 100
const LIVE_SESSION_LIMIT = 500
const TURN_PAGE_ROWS = 100
const TURN_PROSE_PAGES = 10
const TURN_WORK_PAGES = 30

const internal = () => new HttpApiError.InternalServerError({})

export const MobileHandlers = HttpApiBuilder.group(
  ArdenApi,
  "mobile",
  Effect.fn("MobileHandlers")(function* (handlers) {
    const sessions = yield* SessionStore
    const spaces = yield* SpaceStore
    const answerBlocks = yield* AnswerBlockStore
    const inbox = yield* InboxStore
    const home = yield* HomeStore
    const runs = yield* RunQueries
    const work = yield* WorkStore
    const history = yield* ChatHistory
    const bus = yield* SessionLifecycleEvents

    const list = (query: SessionListQuery) =>
      sessions.list(query).pipe(Effect.map((rows) => rows.map(listedSessionToWire)))

    const busHead = Effect.scoped(bus.open()).pipe(Effect.map((opened) => opened.initialSequence))

    const taskPlaces = Effect.fn("MobileHandlers.taskPlaces")(function* (
      itemIds: ReadonlyArray<string>
    ) {
      const tasks = yield* Effect.forEach(itemIds, (itemId) =>
        work.get({ kind: "item", itemId }).pipe(
          Effect.map((task): [string, SpaceTask][] => [[itemId, task]]),
          Effect.catch(() => Effect.succeed([]))
        )
      )
      const pairs = tasks.flat()
      const spaceIds = pairs.some(([, task]) => task.space_id !== null)
        ? new Set((yield* spaces.list()).map((space) => space.space_id))
        : new Set<string>()
      const sessionIds = [
        ...new Set(
          pairs.flatMap(([, task]) =>
            task.space_id === null && task.home_session_id !== null ? [task.home_session_id] : []
          )
        )
      ]
      const alive = new Set(
        sessionIds.length === 0
          ? []
          : (yield* list({ sessionIds, scope: "all", limit: sessionIds.length })).map(
              (row) => row.session_id
            )
      )
      return new Map(
        pairs.flatMap(([itemId, task]): [string, PhoneHome][] => {
          if (task.space_id !== null)
            return spaceIds.has(task.space_id)
              ? [[itemId, { kind: "space", id: task.space_id }]]
              : []
          return task.home_session_id !== null && alive.has(task.home_session_id)
            ? [[itemId, { kind: "session", id: task.home_session_id }]]
            : []
        })
      )
    })

    const loadAsks = Effect.fn("MobileHandlers.loadAsks")(function* () {
      const items = (yield* inbox.view()).groups.flatMap((group) => group.items)
      const questions = items.flatMap((item): RunQuestion[] =>
        item.source === "question" ? [item.question] : []
      )
      const approvals = items.flatMap((item): RunApproval[] =>
        item.source === "approval" ? [item.approval] : []
      )
      const sessionIds = [
        ...new Set([...questions, ...approvals].map((ask) => ask.destination_session_id))
      ]
      const asking =
        sessionIds.length === 0
          ? []
          : yield* list({ sessionIds, scope: "all", limit: sessionIds.length })
      const places = new Map(
        asking.map((session): [string, AskPlace] => [
          session.session_id,
          {
            name: session.name ?? undefined,
            spaceId: session.space_id ?? undefined,
            home: isSpaceHome(session),
            onboarding: session.origin === "onboarding"
          }
        ])
      )
      const spaceNames = new Map(
        (yield* spaces.list()).map((space) => [space.space_id, space.name])
      )
      return mobileAsks({ questions, approvals, places, spaceNames })
    })

    const homeView = Effect.fn("MobileHandlers.home")(function* () {
      const cursor = yield* busHead
      const asks = yield* loadAsks()
      const letters = yield* addressedHomeLetter(home)
      const newest = letters.letters.find((letter) => letter.body.paragraphs.length > 0)
      const { refs, taskIds } =
        newest === undefined ? { refs: [], taskIds: [] } : letterLookupKeys(newest)
      const resolved = yield* Effect.forEach(refs, (sessionRef) =>
        list({ sessionRef, scope: "all", limit: 1 }).pipe(
          Effect.map((rows) => rows.map((row): [string, string] => [sessionRef, row.session_id]))
        )
      )
      return {
        asks,
        letter:
          newest === undefined
            ? null
            : mobileLetter(newest, {
                sessionIds: new Map(resolved.flat()),
                taskPlaces: yield* taskPlaces(taskIds)
              }),
        next_at: letters.next_at,
        cursor
      }
    })

    const spacesView = Effect.fn("MobileHandlers.spaces")(function* () {
      const cursor = yield* busHead
      const asks = yield* loadAsks()
      const overview = yield* spaces.overview()
      const live = yield* list({ live: true, scope: "all", limit: LIVE_SESSION_LIMIT })
      const spaceRow = Effect.fn("MobileHandlers.spaceRow")(function* (space: SpaceSummary) {
        return mobileSpace({
          space,
          chats: yield* list({ spaceId: space.key, scope: "primary", limit: SPACE_CHAT_LIMIT }),
          live: live.filter((session) => session.space_id === space.key),
          asks: asks.filter((ask: MobileAsk) => ask.space_id === space.key)
        })
      })
      const rows = yield* Effect.forEach(overview.spaces, spaceRow)
      return {
        spaces: rows,
        loose: looseChats(yield* list({ inbox: true, scope: "primary", limit: LOOSE_CHAT_LIMIT })),
        cursor
      }
    })

    const conversationView = Effect.fn("MobileHandlers.conversation")(function* (
      sessionId: string,
      before: string | undefined
    ) {
      const page = yield* history.get(before === undefined ? { sessionId } : { sessionId, before })
      const [session] = yield* list({ sessionIds: [sessionId], scope: "all", limit: 1 })
      if (session === undefined) return yield* new HttpApiError.NotFound({})
      const active = page.runtime.active_run
      const progress =
        active === null ? undefined : ((yield* runs.progress(active.run_id)) ?? undefined)
      const keys = conversationLookupKeys(page)
      const resolved = yield* Effect.forEach(keys.refs, (sessionRef) =>
        list({ sessionRef, scope: "all", limit: 1 }).pipe(
          Effect.map((rows) => rows.map((row): [string, string] => [sessionRef, row.session_id]))
        )
      )
      const sessionIds = new Map(resolved.flat())
      const taskHomes = yield* taskPlaces(keys.taskIds)
      const named = [...new Set([...keys.sessionIds, ...sessionIds.values()])]
      const names = new Map(
        (named.length === 0
          ? []
          : yield* list({ sessionIds: named, scope: "all", limit: named.length })
        ).map((row): [string, string] => [row.session_id, chatName(row)])
      )
      const savedBlocks = new Map<string, Map<number, JsonObject>>()
      for (const saved of yield* answerBlocks.list(sessionId)) {
        const blocks = savedBlocks.get(saved.messageId) ?? new Map<number, JsonObject>()
        blocks.set(saved.blockIndex, saved.state)
        savedBlocks.set(saved.messageId, blocks)
      }
      const spaceId = session.space_id ?? null
      const spaceChats =
        spaceId === null ? [] : yield* list({ spaceId, scope: "primary", limit: SPACE_CHAT_LIMIT })
      return {
        session_id: sessionId,
        title: chatName(session),
        space_id: spaceId,
        ...conversationPage({
          history: page,
          progress,
          now: DateTime.formatIso(yield* DateTime.now),
          lookups: { sessionIds, taskPlaces: taskHomes, names, savedBlocks }
        }),
        chats: spaceChats
          .filter(
            (chat: SessionListItem) =>
              chat.session_id !== sessionId &&
              chat.presentation?.kind === "conversation" &&
              !isSpaceHome(chat)
          )
          .map((chat) => ({
            session_id: chat.session_id,
            title: chatName(chat),
            updated_at: chat.last_activity,
            working: chat.is_active === true
          }))
      }
    })

    const turnProse = Effect.fn("MobileHandlers.turnProse")(function* (
      sessionId: string,
      turnId: string
    ) {
      const first = yield* history.get({ sessionId, around: turnId, limit: TURN_PAGE_ROWS })
      const pages = [first]
      const nextAfter = (page: HistoryResponse): string | undefined =>
        page.page.has_more_after && page.messages.at(-1)?.turn_id === turnId
          ? (page.page.after ?? undefined)
          : undefined
      let after = nextAfter(first)
      while (after !== undefined && pages.length < TURN_PROSE_PAGES) {
        const page = yield* history.get({ sessionId, after, limit: TURN_PAGE_ROWS })
        pages.push(page)
        after = nextAfter(page)
      }
      return {
        first,
        messages: pages.flatMap((page) => page.messages).filter((row) => row.turn_id === turnId)
      }
    })

    const turnWork = Effect.fn("MobileHandlers.turnWork")(function* (
      sessionId: string,
      turnId: string
    ) {
      const read = (before: string | undefined) =>
        history.getTurnWork({
          sessionId,
          turnId,
          limit: TURN_PAGE_ROWS,
          view: "compact",
          ...(before === undefined ? {} : { before })
        })
      const nextBefore = (page: TurnWorkResponse): string | undefined =>
        page.page.has_more_before ? (page.page.before ?? undefined) : undefined
      const newest = yield* read(undefined)
      const pages = [newest]
      let before = nextBefore(newest)
      while (before !== undefined && pages.length < TURN_WORK_PAGES) {
        const page = yield* read(before)
        pages.unshift(page)
        before = nextBefore(page)
      }
      const rows = new Map<string, HistoryMessage>()
      for (const row of pages.flatMap((page) => page.messages)) rows.set(row.message_id, row)
      return [...rows.values()]
    })

    const turnView = Effect.fn("MobileHandlers.turn")(function* (
      sessionId: string,
      turnId: string
    ) {
      const prose = yield* turnProse(sessionId, turnId)
      const shell = prose.first.turn_shells?.find((candidate) => candidate.turn_id === turnId)
      if (shell === undefined) return yield* new HttpApiError.NotFound({})
      const active = prose.first.runtime.active_run
      return turnRail({
        shell,
        conversation: prose.messages,
        work: yield* turnWork(sessionId, turnId),
        running: active !== null && active.turn_id === turnId && isActiveRunStatus(active.status)
      })
    })

    return handlers
      .handle("home", () => homeView().pipe(Effect.mapError(internal)))
      .handle("spaces", () => spacesView().pipe(Effect.mapError(internal)))
      .handle("conversation", ({ params, query }) =>
        conversationView(params.sessionId, query.before).pipe(
          Effect.mapError((error) => {
            if (error instanceof HttpApiError.NotFound || error instanceof ChatSessionNotFound)
              return new HttpApiError.NotFound({})
            if (error instanceof ChatHistoryInvalidCursor) return new HttpApiError.BadRequest({})
            return internal()
          })
        )
      )
      .handle("turn", ({ params }) =>
        turnView(params.sessionId, params.turnId).pipe(
          Effect.mapError((error) =>
            error instanceof HttpApiError.NotFound ||
            error instanceof ChatSessionNotFound ||
            error instanceof ChatTurnNotFound ||
            error instanceof ChatHistoryInvalidCursor
              ? new HttpApiError.NotFound({})
              : internal()
          )
        )
      )
  })
)
