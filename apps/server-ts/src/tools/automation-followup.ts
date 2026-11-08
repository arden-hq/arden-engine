import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { AutomationQueue } from "../persistence/automations/queue.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt } from "./call-receipt.js"
import { automationResource } from "./automation-records.js"

const makeAutomationFollowupTools = ({
  queue
}: {
  readonly queue: AutomationQueue["Service"]
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "automation_followup",
    description:
      "Control only this running Automation's future checks. Use stop when the authorized outcome is confirmed or checking is no longer needed: its job is done, and it is removed with its chat archived. Use check_again with a future ISO timestamp for the next check, including from a one-time run. Only this Automation's own run holds it. Applied when this run, and any agents it started, finish successfully; a later user pause or settings change wins. Does not change instructions, permissions, or other Automations. Do not use automation_update from a scheduled worker.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        followup: Schema.Union([
          Schema.Struct({ action: Schema.Literal("stop") }),
          Schema.Struct({ action: Schema.Literal("check_again"), at: Schema.String })
        ])
      })
    ),
    metadata: {
      effect: "run_record",
      display_name: "Set follow-up",
      kind: "tool",
      action: "write",
      source: "_automations",
      outcome: true,
      actor: "user_automation",
      default_approval: "approve",
      policy_scope: "internal",
      changes_state: true,
      target: "reported",
      concurrency_group: "automation-followup",
      destructive: false
    },
    execute: async (input, ctx, effects) => {
      const owner = await recordApplied(
        effects,
        Effect.runPromise(
          queue.setFollowup({
            sessionId: ctx.run.sessionId,
            chatRunId: ctx.run.runId,
            followup: input.followup
          }),
          { signal: ctx.signal }
        )
      )
      return {
        result:
          input.followup.action === "stop"
            ? "Saved: this Automation's job is done; it is removed when this run completes successfully."
            : `Saved: this Automation's next check will be at ${input.followup.at} when this run completes successfully.`,
        preview: "Follow-up saved",
        host: appliedReceipt(
          ctx,
          automationResource(
            owner,
            input.followup.action === "stop"
              ? `${owner.name}: stops checking`
              : `${owner.name}: next check scheduled`
          )
        )
      }
    }
  })
]

export const automationFollowupTools = Effect.gen(function* () {
  return makeAutomationFollowupTools({ queue: yield* AutomationQueue })
})
