import { Effect, Schema } from "effect"

import type { StructuredCompletion } from "../models/structured-completion.js"
import type {
  ConnectionItem,
  ConnectionItemStore,
  RouteDecision
} from "../persistence/connections/store.js"
import type { PersistedSpace } from "../persistence/spaces/store.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import { clean, makeRouterSpaces, type RouterCandidateDependencies } from "./candidates.js"

const BATCH = 20
const PENDING_READ = 200

const ItemRoutesSchema = Schema.Struct({
  routes: Schema.Array(
    Schema.Struct({
      item: Schema.String.annotate({ description: 'The item id, such as "i3".' }),
      to: Schema.String.annotate({ description: 'A Space id such as "space:d2", or "home".' }),
      reason: Schema.String.check(Schema.isMaxLength(400)),
      offer: Schema.String.check(Schema.isMaxLength(200))
    })
  )
})

type ItemRoutes = (typeof ItemRoutesSchema)["Type"]

export interface ItemRoute extends RouteDecision {
  readonly offer: string | undefined
}

interface ListedSpace {
  readonly id: string
  readonly spaceId: string
}

const decideItemRoutes = (
  answer: ItemRoutes,
  batch: ReadonlyArray<{ readonly id: string; readonly itemId: string }>,
  spaces: ReadonlyArray<ListedSpace>
): ReadonlyArray<ItemRoute> =>
  batch.map(({ id, itemId }) => {
    const route = answer.routes.find((candidate) => candidate.item.trim() === id)
    const reason =
      route === undefined
        ? "The router gave no answer for it."
        : clean(route.reason) || "The router gave no reason."
    const to = route?.to.trim() ?? ""
    const space = spaces.find((listed) => `space:${listed.id}` === to)
    if (space !== undefined)
      return { itemId, spaceId: space.spaceId, basis: "router", reason, offer: undefined }
    const offer = clean(route?.offer ?? "")
    return {
      itemId,
      spaceId: undefined,
      basis: "home",
      reason,
      offer: offer.length === 0 ? undefined : offer
    }
  })

const renderItems = (
  batch: ReadonlyArray<{ readonly id: string; readonly item: ConnectionItem }>
) =>
  [
    "<items>",
    ...batch.map(({ id, item }) =>
      JSON.stringify({
        id,
        source: item.source,
        from: item.sender ?? null,
        title: item.title,
        snippet: item.snippet,
        received: item.receivedAt
      })
    ),
    "</items>"
  ].join("\n")

export interface ItemRouterDependencies extends Pick<
  RouterCandidateDependencies,
  "spaces" | "work"
> {
  readonly completion: StructuredCompletion["Service"]
  readonly store: ConnectionItemStore["Service"]
}

interface RoutePass {
  readonly offers: ReadonlyArray<ItemRoute & { readonly offer: string }>
  readonly modelCalled: boolean
}

const active = (space: PersistedSpace): boolean => space.archived_at === null

export const makeItemRouter = (dependencies: ItemRouterDependencies) => {
  const spacesOf = makeRouterSpaces(dependencies, active)
  return Effect.fn("ItemRouter.route")(function* (options: { readonly allowModel: boolean }) {
    yield* dependencies.store.routeOwnedThreads()
    const rest = options.allowModel ? yield* dependencies.store.pending(PENDING_READ) : []
    if (rest.length === 0) return { offers: [], modelCalled: false } satisfies RoutePass
    const spaces = (yield* spacesOf()).map((space, index) => ({ ...space, id: `d${index + 1}` }))
    const listed = [
      "Spaces:",
      ...spaces.map((space) =>
        [
          `- space:${space.id} ${space.name}: ${space.instructions || "(no description)"}`,
          ...space.tasks.map((task) => `  · open task: ${task}`)
        ].join("\n")
      )
    ].join("\n")
    const offers: Array<ItemRoute & { readonly offer: string }> = []
    for (let start = 0; start < rest.length; start += BATCH) {
      const batch = rest
        .slice(start, start + BATCH)
        .map((item, index) => ({ id: `i${index + 1}`, itemId: item.itemId, item }))
      const answer = yield* dependencies.completion
        .runTool({
          role: "helper",
          usage: { kind: "item_routing", owner: { type: "none" } },
          system: PROMPT_TEXT.itemRouter,
          user: [listed, "", renderItems(batch)].join("\n"),
          maxOutputTokens: 2_000,
          result: {
            schema: ItemRoutesSchema,
            name: "route_items",
            displayName: "Route Items",
            description: "Say which Space each new item belongs on, or Home."
          }
        })
        .pipe(
          Effect.tapCause((cause) => Effect.logWarning("Item routing call failed", cause)),
          Effect.option
        )
      const routes = decideItemRoutes(
        answer._tag === "Some" ? answer.value : { routes: [] },
        batch,
        spaces
      )
      yield* dependencies.store.route(routes)
      for (const route of routes)
        if (route.offer !== undefined) offers.push({ ...route, offer: route.offer })
    }
    return { offers, modelCalled: true } satisfies RoutePass
  })
}
