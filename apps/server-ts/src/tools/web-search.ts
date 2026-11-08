import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"

const EmptyParametersSchema = Schema.Record(Schema.String, Schema.Never)

const parameterJsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
} as const

const makeWebSearchTool = (): ServerTool =>
  defineServerTool({
    name: "web_search",
    description: "Search the live public web and return cited sources.",
    parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
    parameterJsonSchema,
    metadata: {
      display: { row: "web_sites" },
      effect: "none",
      hosted: true,
      display_name: "Web search",
      kind: "web",
      action: "read",
      approval_preview: "Search the public web.",
      source: "_web",
      changes_state: false,
      concurrency_group: "web",
      destructive: null,
      policy_scope: "external",
      permissions: ["web"],
      open_world: true,
      idempotent: true
    },
    execute: async () => {
      throw new ToolExecutionError(
        "web_search requires an OpenAI Responses provider with hosted web search support.",
        { preview: "Hosted web search unavailable", retryable: false }
      )
    }
  })

export const webSearchTools = Effect.sync(() => [makeWebSearchTool()])
