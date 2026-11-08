import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { ModelCatalog } from "../models/catalog.js"

const makeModelCatalogTool = ({
  models
}: {
  readonly models: Pick<ModelCatalog["Service"], "catalog">
}): ServerTool =>
  defineServerTool({
    name: "model_catalog",
    description:
      "List the model IDs and reasoning efforts currently available to Arden. Call before choosing a model for spawn_agent, a code_mode agent(), or an Automation; use an exact ID from this list. A Chat-attached Automation follows its Chat model.",
    parameters: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Never)),
    metadata: {
      effect: "none",
      display_name: "List available models",
      kind: "tool",
      action: "read",
      source: "_system",
      changes_state: false,
      concurrency_group: null,
      destructive: false,
      approval_preview: "Check which models you can use."
    },
    execute: async (_input, ctx) => {
      const catalog = await Effect.runPromise(models.catalog({ refresh: "fresh" }), {
        signal: ctx.signal
      }).catch((cause: unknown) => {
        if (ctx.signal.aborted) throw cause
        throw new ToolExecutionError(
          "Could not refresh the model catalog. Omit model to inherit the current run's model.",
          {
            preview: "Model catalog unavailable",
            retryable: true
          }
        )
      })
      const available = catalog.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          id: model.id,
          name: model.name,
          provider: provider.name,
          reasoning_efforts: [...model.reasoningEfforts]
        }))
      )
      return {
        result: JSON.stringify({ models: available }),
        preview: `${countOf(available.length, "available model")}`,
        data: { models: available }
      }
    }
  })

export const modelCatalogTools = Effect.gen(function* () {
  return [makeModelCatalogTool({ models: yield* ModelCatalog })]
})
