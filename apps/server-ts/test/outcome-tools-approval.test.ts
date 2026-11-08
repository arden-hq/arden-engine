import { defaultImpact } from "../src/execution/impact.js"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { dataRootLayer } from "../src/runtime/data-root.js"
import { Effect, Layer, Schema } from "effect"
import { expect, it } from "vitest"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"
import { decide as decideCall } from "../src/execution/decide.js"
import { toolFacts } from "../src/tools/approval-decision.js"
import { automationFollowupTools } from "../src/tools/automation-followup.js"
import { defineServerTool, type ServerTool } from "../src/tools/define.js"
import { spaceReviewFinishTools } from "../src/tools/space-review-finish.js"
import { reportTools } from "../src/tools/report.js"
import { workTools } from "../src/tools/work.js"
import { runAuthority } from "./kit.js"

const MODES: ReadonlyArray<ChatApprovalMode> = ["read_only", "ask", "safe", "allow"]

const write: ServerTool = defineServerTool({
  name: "wiki_edit",
  description: "Edit",
  parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
  metadata: {
    display_name: "Edit",
    kind: "tool",
    action: "write",
    source: "_wiki",
    effect: "arden_db",
    changes_state: true,
    target: "reported",
    default_approval: "ask",
    concurrency_group: null,
    destructive: false
  },
  execute: async () => ({ result: "edited", preview: "edited" })
})

const decide = (tool: ServerTool, mode: ChatApprovalMode, available = true) =>
  decideCall(
    runAuthority(),
    { state: "active", mode, rule: undefined },
    {
      tool: toolFacts(tool.definition),
      available,
      unattended_scope: false,
      floor: undefined,
      target: undefined,
      requirement: false,
      user_only: false,
      reads_only: true,
      impact: defaultImpact(toolFacts(tool.definition)),
      approved: false
    }
  ).kind

it("allows every run outcome tool in every approval mode and refuses writes when read-only", async () => {
  const tools = await Effect.runPromise(
    Effect.all([reportTools, automationFollowupTools, spaceReviewFinishTools, workTools]).pipe(
      Effect.map((groups) => groups.flat()),
      Effect.provide(
        Layer.merge(
          sqlitePersistenceLayer({ dataDir: null, filename: ":memory:" }).pipe(
            Layer.provide(PersistenceWriteQueue.layer)
          ),
          dataRootLayer({ kind: "disk", databasePath: "/nonexistent/arden-state/arden.db" })
        )
      )
    )
  )
  const outcomes = ["report", "automation_followup", "space_review_finish", "ask_user"].map(
    (name) => {
      const tool = tools.find((candidate) => candidate.definition.name === name)
      if (tool === undefined) throw new Error(`Missing ${name}`)
      return tool
    }
  )
  const decisions = Object.fromEntries(
    [...outcomes, write].map((tool) => [
      tool.definition.name,
      MODES.map((mode) => decide(tool, mode))
    ])
  )
  const always = ["allow", "allow", "allow", "allow"]
  expect(decisions).toEqual({
    report: always,
    automation_followup: always,
    space_review_finish: always,
    ask_user: always,
    wiki_edit: ["deny", "ask", "ask", "allow"]
  })
  expect(outcomes.map((tool) => decide(tool, "allow", false))).toEqual(outcomes.map(() => "deny"))
})
