import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { makeSourceReferences } from "../../tools/source-references.js"
import { GoogleConnections } from "../../google/service.js"
import { AutomationCatalog } from "../../persistence/automations/catalog.js"
import { RunQueries } from "../../persistence/runs/queries.js"
import { SessionQueries } from "../../persistence/sessions/queries.js"
import { ArdenApi } from "../api.js"
export const SourceTitleHandlers = HttpApiBuilder.group(
  ArdenApi,
  "sourceTitles",
  Effect.fn(function* (handlers) {
    const google = yield* GoogleConnections
    const automations = yield* AutomationCatalog
    const runs = yield* RunQueries
    const sessions = yield* SessionQueries
    const sources = makeSourceReferences({ google, automations, runs, sessions })
    return handlers.handle("readSourceTitle", ({ payload }) =>
      Effect.promise(async () => ({ sources: await sources.read(payload.sources) }))
    )
  })
)
