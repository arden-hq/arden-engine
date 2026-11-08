import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { makeRecipeDraft } from "../../assist/recipe-draft.js"
import { StructuredCompletion } from "../../models/structured-completion.js"
import { SkillCatalog } from "../../skills/service.js"
import { ArdenApi } from "../api.js"
import { completionErrorToHttp, failStore } from "../errors.js"

const listError = (): HttpApiError.InternalServerError => new HttpApiError.InternalServerError({})

export const SkillHandlers = HttpApiBuilder.group(
  ArdenApi,
  "skills",
  Effect.fn("SkillHandlers")(function* (handlers) {
    const skills = yield* SkillCatalog
    const draftRecipe = makeRecipeDraft({ completion: yield* StructuredCompletion })
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
      .handle("createRecipe", ({ payload }) =>
        skills.createRecipe(payload).pipe(Effect.catch(failStore))
      )
      .handle("draftRecipe", ({ payload }) =>
        draftRecipe(payload.text).pipe(Effect.mapError((error) => completionErrorToHttp(error)))
      )
      .handle("updateRecipe", ({ params, payload }) =>
        skills.updateRecipe(params.name, payload).pipe(Effect.catch(failStore))
      )
      .handle("content", ({ params }) => skills.content(params.name).pipe(Effect.catch(failStore)))
      .handle("setEnabled", ({ params, payload }) =>
        skills.setEnabled(params.name, payload.enabled).pipe(Effect.catch(failStore))
      )
      .handle("remove", ({ params }) => skills.remove(params.name).pipe(Effect.catch(failStore)))
  })
)
