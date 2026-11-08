import { DateTime, Effect } from "effect"

import type { SpaceStore, PersistedSpace } from "../persistence/spaces/store.js"
import type { TaskProposalStore } from "../persistence/proposals/store.js"
import type { SessionStore } from "../persistence/sessions/store.js"
import type { SummaryStore } from "../persistence/summaries/store.js"
import type { WorkStore } from "../persistence/work/store.js"

const RECENT_CHAT_DAYS = 14
const MAX_CHATS = 30
const MAX_TASKS_PER_SPACE = 12

interface RouterChat {
  readonly id: string
  readonly sessionId: string
  readonly name: string
  readonly space: string | undefined
  readonly text: string
}

interface RouterSpace {
  readonly spaceId: string
  readonly name: string
  readonly instructions: string
  readonly tasks: ReadonlyArray<string>
  readonly home: { readonly sessionId: string; readonly name: string } | undefined
}

export interface RouterCandidates {
  readonly spaces: ReadonlyArray<RouterSpace>
  readonly chats: ReadonlyArray<RouterChat>
}

export const clean = (text: string): string => text.replace(/\s+/gu, " ").trim()

export interface RouterCandidateDependencies {
  readonly spaces: SpaceStore["Service"]
  readonly work: WorkStore["Service"]
  readonly sessions: SessionStore["Service"]
  readonly summaries: SummaryStore["Service"]
}

interface OfferSpace {
  readonly spaceId: string
  readonly name: string
  readonly instructions: string
  readonly offers: ReadonlyArray<string>
}

export const loadOfferSpaces = Effect.fn("Router.offerSpaces")(function* (
  proposals: TaskProposalStore["Service"],
  spaces: ReadonlyArray<PersistedSpace>
) {
  const listed: Array<OfferSpace> = []
  for (const space of spaces) {
    const offers = (yield* proposals.list({ place: "space", spaceId: space.space_id })).proposals
      .filter((proposal) => proposal.status === "offered")
      .slice(0, MAX_TASKS_PER_SPACE)
      .map((proposal) => clean(proposal.text).slice(0, 220))
    if (offers.length > 0)
      listed.push({
        spaceId: space.space_id,
        name: space.name,
        instructions: clean(space.instructions ?? "").slice(0, 500),
        offers
      })
  }
  return listed
})

export const renderOfferSpaces = (spaces: ReadonlyArray<OfferSpace>) => {
  const ids: Array<{ readonly id: string; readonly spaceId: string }> = []
  const text = spaces
    .flatMap((space) => [
      `- ${space.name}: ${space.instructions || "(no description)"}`,
      ...space.offers.map((offer) => {
        const id = `o${ids.length + 1}`
        ids.push({ id, spaceId: space.spaceId })
        return `  · open offer ${id}: ${offer}`
      })
    ])
    .join("\n")
  return { text, ids }
}

export const makeRouterSpaces = (
  dependencies: Pick<RouterCandidateDependencies, "spaces" | "work">,
  include: (space: PersistedSpace) => boolean
) => {
  const routerSpace = Effect.fn("Router.space")(function* (space: PersistedSpace) {
    const detail = yield* dependencies.spaces.detail(space.space_id)
    const page = yield* dependencies.work.page({ spaceId: space.space_id, limit: 50 })
    const tasks = page.items
      .filter((task) => task.status !== "done" && task.status !== "cancelled")
      .slice(0, MAX_TASKS_PER_SPACE)
      .map((task) => clean(task.text).slice(0, 220))
    const homeId = detail?.conversation_session_id ?? null
    return {
      spaceId: space.space_id,
      name: space.name,
      instructions: clean(space.instructions ?? "").slice(0, 500),
      tasks,
      home: homeId === null ? undefined : { sessionId: homeId, name: space.name }
    } satisfies RouterSpace
  })
  return Effect.fn("Router.spaces")(function* () {
    return yield* Effect.forEach((yield* dependencies.spaces.list()).filter(include), routerSpace)
  })
}

export const makeRouterCandidates = (dependencies: RouterCandidateDependencies) => {
  const spacesOf = makeRouterSpaces(dependencies, () => true)
  return Effect.fn("Router.candidates")(function* () {
    const spaces = yield* dependencies.spaces.list()
    const spaceName = new Map(spaces.map((space) => [space.space_id, space.name]))
    const routerSpaces = yield* spacesOf()
    const since = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: RECENT_CHAT_DAYS })
    )
    const listed = (yield* dependencies.sessions.list({
      scope: "primary",
      sort: "activity",
      limit: 80
    })).filter(
      (session) =>
        session.sessionType === "chat" &&
        session.parentSessionId === undefined &&
        session.originAutomationId === undefined &&
        session.messageCount >= 2 &&
        session.lastActivity >= since
    )
    const recent = listed.slice(0, MAX_CHATS)
    const summaries = yield* dependencies.summaries.chats(
      recent.map((session) => session.sessionId)
    )
    const chats = recent.map((session, index): RouterChat => {
      const summary = summaries.get(session.sessionId)
      const name = session.name?.trim() || "Untitled chat"
      return {
        id: `c${index + 1}`,
        sessionId: session.sessionId,
        name,
        space: session.spaceId === undefined ? undefined : spaceName.get(session.spaceId),
        text: summary === undefined ? name : clean(`${summary.title}: ${summary.summary}`)
      }
    })
    return { spaces: routerSpaces, chats } satisfies RouterCandidates
  })
}
