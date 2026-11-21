import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { SkillCatalog } from "../../skills/service.js"
import { ArdenApi } from "../api.js"
import { failStore } from "../errors.js"

const listError = (): HttpApiError.InternalServerError => new HttpApiError.InternalServerError({})

export const SkillHandlers = HttpApiBuilder.group(
  ArdenApi,
  "skills",
  Effect.fn("SkillHandlers")(function* (handlers) {
    const skills = yield* SkillCatalog
    return handlers
      .handle("list", () =>
        skills.list().pipe(
          Effect.map((items) => ({ skills: items })),
          Effect.mapError(listError)
        )
      )
      .handle("marketplacePopular", () =>
        skills.marketplacePopular().pipe(
          Effect.map((items) => ({ skills: items })),
          Effect.catch(failStore)
        )
      )
      .handle("marketplaceSearch", ({ query }) =>
        skills.marketplaceSearch(query.q).pipe(
          Effect.map((items) => ({ skills: items })),
          Effect.catch(failStore)
        )
      )
      .handle("installMarketplace", ({ payload }) =>
        skills.installMarketplace(payload.id).pipe(Effect.catch(failStore))
      )
      .handle("content", ({ params }) => skills.content(params.name).pipe(Effect.catch(failStore)))
      .handle("setEnabled", ({ params, payload }) =>
        skills.setEnabled(params.name, payload.enabled).pipe(Effect.catch(failStore))
      )
      .handle("remove", ({ params }) => skills.remove(params.name).pipe(Effect.catch(failStore)))
  })
)
