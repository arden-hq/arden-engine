import { Effect, Exit, Schema } from "effect"
import { expect, it } from "vitest"
import { defineServerTool } from "../src/tools/define.js"
import { checkToolContract } from "../src/tools/tool-contract.js"
import { EmptyParametersSchema } from "../src/tools/automation-tool-schema.js"

const tool = (name: string, extra: { readonly summary?: string; readonly internal?: true }) =>
  defineServerTool({
    name,
    ...(extra.summary === undefined ? {} : { summary: extra.summary }),
    description: `The long text the model reads for ${name}.`,
    parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
    metadata: {
      effect: "none",
      display_name: name,
      kind: "tool",
      action: "read",
      source: "_test",
      changes_state: false,
      concurrency_group: null,
      destructive: null,
      ...(extra.internal === undefined ? {} : { internal_catalog: true })
    },
    execute: async () => "done"
  })

const problems = (tools: ReadonlyArray<ReturnType<typeof tool>>) => {
  const exit = Effect.runSyncExit(checkToolContract(tools))
  return Exit.isSuccess(exit)
    ? []
    : String(Exit.isFailure(exit) ? exit.cause : "")
        .split("\n")
        .filter((line) => line.startsWith("made_up"))
}

it("a public tool needs its own non-empty summary; an internal one needs none", () => {
  expect(problems([tool("made_up_kept", { summary: "Does one made-up thing." })])).toEqual([])
  expect(problems([tool("made_up_internal", { internal: true })])).toEqual([])
  expect(problems([tool("made_up_missing", {})])).toEqual(["made_up_missing has no summary"])
  expect(problems([tool("made_up_blank", { summary: "  " })])).toEqual([
    "made_up_blank has an empty summary"
  ])
})
