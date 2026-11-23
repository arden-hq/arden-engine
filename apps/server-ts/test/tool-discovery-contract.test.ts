import { Schema } from "effect"
import { expect, it } from "vitest"
import { defineServerTool, type ToolDiscovery } from "../src/tools/define.js"
import { applyToolCatalog, preloadToolNames } from "../src/tools/tool-catalog.js"
import { EmptyParametersSchema } from "../src/tools/automation-tool-schema.js"

const tool = (
  name: string,
  extra: { readonly discovery?: unknown; readonly source?: string; readonly hosted?: true } = {}
) =>
  defineServerTool({
    name,
    summary: `Does ${name}.`,
    ...(extra.discovery === undefined ? {} : { discovery: extra.discovery as ToolDiscovery }),
    description: `The long text the model reads for ${name}.`,
    parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
    metadata: {
      effect: "none",
      display_name: name,
      kind: "tool",
      action: "read",
      source: extra.source ?? "_test",
      changes_state: false,
      concurrency_group: null,
      destructive: null,
      ...(extra.hosted === undefined ? {} : { hosted: true })
    },
    execute: async () => "done"
  })
const schema = () => ({ type: "object", properties: {} })

it("a malformed fact is refused where the tool is defined", () => {
  for (const discovery of [
    "always",
    {},
    { group: "" },
    { group: "Made_Up" },
    { group: "made-up" },
    { group: "browser" },
    { group: "mcp_made_up" },
    { group: "made_up", extra: true },
    { group: 7 }
  ])
    expect(() => tool("made_up_bad", { discovery }), JSON.stringify(discovery)).toThrow(
      /made_up_bad has an invalid discovery/
    )
  expect(() => tool("made_up_ok", { discovery: { group: "web_browser" } })).not.toThrow()
})

it("a broad run defers by the definition's fact; MCP tools get their server's group", () => {
  const tools = [
    tool("made_up_always", { discovery: "always_loaded" }),
    tool("made_up_grouped", { discovery: { group: "made_up" } }),
    tool("made_up_none"),
    tool("made_up_hosted", { hosted: true }),
    tool("mcp__my_server__lookup", { source: "mcp:my.server/1" })
  ]
  const entries = tools.map((each) => each.entry(schema))
  const context = (scope: "all" | "worker") => ({
    scopes: [scope] as const,
    tools: new Map(tools.map((each) => [each.definition.name, each]))
  })
  const shown = applyToolCatalog(entries, context("all")).map((entry) => ({
    name: entry.meta.name,
    deferred: entry.meta.deferred,
    group: entry.meta.group
  }))
  expect(shown).toEqual([
    { name: "made_up_always", deferred: false, group: undefined },
    { name: "made_up_grouped", deferred: true, group: "made_up" },
    { name: "made_up_none", deferred: true, group: undefined },
    { name: "made_up_hosted", deferred: false, group: undefined },
    { name: "mcp__my_server__lookup", deferred: true, group: "mcp_my_server_1" }
  ])
  expect(applyToolCatalog(entries, context("worker"))).toEqual(entries)
})

it("a chat preload is its named tools, then its groups' tools in definition order", () => {
  const tools = [
    tool("made_up_b", { discovery: { group: "second" } }),
    tool("made_up_a", { discovery: { group: "first" } }),
    tool("made_up_c", { discovery: { group: "second" } }),
    tool("made_up_d", { discovery: "always_loaded" })
  ]
  expect(preloadToolNames(tools, { tools: ["made_up_d"], groups: ["second", "first"] })).toEqual([
    "made_up_d",
    "made_up_b",
    "made_up_c",
    "made_up_a"
  ])
})
