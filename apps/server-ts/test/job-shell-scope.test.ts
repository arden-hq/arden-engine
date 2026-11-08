import { Schema } from "effect"
import { expect, it } from "vitest"
import { defineServerTool, type ServerTool } from "../src/tools/define.js"
import { scopedRunToolNames, scopedToolNames } from "../src/tools/tool-scopes.js"

const tool = (name: string, source: string, action: "read" | "write"): ServerTool =>
  defineServerTool({
    name,
    description: name,
    parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
    metadata: {
      display_name: name,
      kind: "tool",
      action,
      source,
      effect: action === "write" ? "arden_db" : "none",
      changes_state: action === "write",
      ...(action === "write" ? { target: "reported" as const } : {}),
      concurrency_group: null,
      destructive: false
    },
    execute: async () => ({ result: "ok", preview: "ok" })
  })

const tools = [tool("wiki_read", "_wiki", "read"), tool("exec_command", "_shell", "write")]
const scopes = scopedToolNames(tools)
const holder = { kind: "tree" } as const

it("adds the shell to a job's scope only when its rules give it", () => {
  const names = (shellByRules: boolean, intersections: Array<"worker" | "observer">) => [
    ...scopedRunToolNames(tools, scopes, "reports", intersections, holder, shellByRules)
  ]
  expect(names(false, ["worker"])).toEqual(["wiki_read"])
  expect(names(true, ["worker"])).toEqual(["wiki_read", "exec_command"])
  expect(names(true, ["worker", "observer"])).toEqual(["wiki_read"])
})

it("gives the rule no other tool", () => {
  const more = [...tools, tool("wiki_write", "_wiki", "write")]
  expect([
    ...scopedRunToolNames(more, scopedToolNames(more), "reports", ["worker"], holder, true)
  ]).toEqual(["wiki_read", "exec_command"])
})
