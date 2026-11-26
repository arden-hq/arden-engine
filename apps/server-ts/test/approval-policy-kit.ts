import { Effect, Schema } from "effect"
import { decide } from "../src/execution/decide.js"
import { defaultImpact } from "../src/execution/impact.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { toolFacts } from "../src/tools/approval-decision.js"
import { reachOf, toolRule, type makeToolApprovalPolicy } from "../src/tools/approval-policy.js"
import { defineServerTool, type ServerTool } from "../src/tools/define.js"
import { scopedToolNames } from "../src/tools/tool-scopes.js"

export const decided = Effect.fn("test.decided")(function* (
  approval: ReturnType<typeof makeToolApprovalPolicy>,
  runId: string,
  tool: ServerTool
) {
  const authority = yield* (yield* RunQueries).authority(runId)
  if (authority === undefined) return yield* Effect.die("no stored authority")
  const live = yield* approval.live({ runId, authority })
  return decide(
    authority,
    { state: live.state, mode: live.mode, rule: toolRule(live, tool.definition) },
    {
      tool: toolFacts(tool.definition),
      ...reachOf({ authority, live, tool, scopeNames: scopedToolNames([tool]) }),
      floor: undefined,
      target: undefined,
      requirement: false,
      user_only: false,
      reads_only: true,
      impact: defaultImpact(toolFacts(tool.definition)),
      approved: false
    }
  ).kind
})

export const report: ServerTool = defineServerTool({
  name: "wiki_publish_report",
  description: "Publish",
  parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
  metadata: {
    display_name: "Publish",
    kind: "tool",
    action: "write",
    source: "_wiki",
    effect: "arden_db",
    changes_state: true,
    target: "reported",
    default_approval: "ask",
    scopes: ["reports"],
    concurrency_group: null,
    destructive: false
  },
  execute: async () => ({ result: "published", preview: "published" })
})
