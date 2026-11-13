import type { ApprovalMode } from "@arden-hq/protocol/permissions"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { WikiEmbeddingIndex } from "../src/embedding/wiki-index.js"
import { decide } from "../src/execution/decide.js"
import { defaultImpact } from "../src/execution/impact.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { PROMPT_TEXT } from "../src/prompts/catalog.js"
import { toolFacts } from "../src/tools/approval-decision.js"
import type { ServerTool } from "../src/tools/define.js"
import { scopedToolNames, toolRunsUnattended } from "../src/tools/tool-scopes.js"
import { wikiTools } from "../src/tools/wiki.js"
import { wikiOperationTools } from "../src/tools/wiki-operations.js"
import { Wiki } from "../src/wiki/service.js"
import { partialService, runAuthority } from "./kit.js"

// Memory Capture and Wiki Maintenance run with nobody watching. A write tool
// their prompts name must run there whatever the job's own approval setting,
// or the run stalls on an ask nobody answers.

const tools = Effect.runSync(
  Effect.all([wikiTools, wikiOperationTools]).pipe(
    Effect.map((groups) => groups.flat()),
    Effect.provideService(Wiki, partialService<Wiki["Service"]>("Wiki", {})),
    Effect.provideService(RunQueries, partialService<RunQueries["Service"]>("RunQueries", {})),
    Effect.provideService(
      WikiEmbeddingIndex,
      partialService<WikiEmbeddingIndex["Service"]>("WikiEmbeddingIndex", {})
    )
  )
)

const memoryRun = runAuthority({
  actor: {
    kind: "automation",
    automation_id: "builtin-wiki-maintenance",
    purpose: "system",
    handler: "wiki_maintenance"
  },
  owns: {
    session_id: "session-fixture",
    space_id: null,
    automation_id: "builtin-wiki-maintenance",
    chain_depth: 0,
    task_item_id: null
  },
  reach: { capabilities: ["memory_capture"], observe: false },
  approval: { follows: { kind: "automation", automation_id: "builtin-wiki-maintenance" } },
  unattended: true
})

const memoryScope = scopedToolNames(tools).memory_capture

const decisionIn = (tool: ServerTool, mode: ApprovalMode) => {
  const facts = toolFacts(tool.definition)
  return decide(
    memoryRun,
    { state: "active", mode, rule: undefined },
    {
      tool: facts,
      available: memoryScope.has(tool.definition.name),
      unattended_scope: toolRunsUnattended(tool, ["memory_capture"]),
      floor: undefined,
      target: undefined,
      requirement: false,
      user_only: false,
      reads_only: false,
      impact: defaultImpact(facts),
      approved: false
    }
  ).kind
}

const writesNamedIn = (prompt: string) =>
  tools.filter((tool) => tool.meta.changes_state && prompt.includes(`\`${tool.definition.name}\``))

describe("Memory run prompts name only tools that run unattended", () => {
  it.each([
    ["Wiki Maintenance", PROMPT_TEXT.wikiMaintenance],
    ["Memory Capture", PROMPT_TEXT.memoryCapture]
  ])("%s can use every write tool its prompt names", (_, prompt) => {
    const named = writesNamedIn(prompt)
    expect(named.length).toBeGreaterThan(0)
    const decisions = Object.fromEntries(
      named.map((tool) => [
        tool.definition.name,
        { ask: decisionIn(tool, "ask"), allow: decisionIn(tool, "allow") }
      ])
    )
    expect(decisions).toEqual(
      Object.fromEntries(
        named.map((tool) => [tool.definition.name, { ask: "allow", allow: "allow" }])
      )
    )
  })

  it("Wiki Maintenance patches pages and Memory Capture creates directories without an ask", () => {
    const byName = (name: string) => {
      const tool = tools.find((candidate) => candidate.definition.name === name)
      if (tool === undefined) throw new Error(`Missing ${name}`)
      return tool
    }
    expect(PROMPT_TEXT.wikiMaintenance).toContain("`wiki_patch_page`")
    expect(decisionIn(byName("wiki_patch_page"), "ask")).toBe("allow")
    expect(decisionIn(byName("wiki_create_directory"), "ask")).toBe("allow")
  })
})
