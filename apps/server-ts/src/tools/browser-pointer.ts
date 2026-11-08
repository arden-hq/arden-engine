import { APPROVAL_FIELD_LABEL } from "@arden-hq/protocol/chat"
import { Effect, Schema } from "effect"
import { BrowserClient } from "../browser/service.js"
import { defineServerTool, type ServerTool } from "./define.js"
import {
  browserOutput,
  OriginSchema,
  originIssues,
  ProfileRefSchema,
  runBrowserForRun,
  TabRefSchema
} from "./browser-support.js"
import { pointTarget, uiTargetData } from "./ui-target.js"

const Point = Schema.Struct({
  x: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1)),
  y: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1))
})
const Fields = {
  tab_ref: TabRefSchema,
  profile_ref: ProfileRefSchema,
  origin: OriginSchema,
  screenshot_ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
}
const Parameters = Schema.Union([
  Schema.Struct({ ...Fields, action: Schema.Literal("click"), point: Point }),
  Schema.Struct({ ...Fields, action: Schema.Literal("drag"), from: Point, to: Point })
]).check(Schema.makeFilter((input) => originIssues(input.origin)))

export const browserPointerTools: Effect.Effect<
  ReadonlyArray<ServerTool>,
  never,
  BrowserClient
> = Effect.gen(function* () {
  const browser = yield* BrowserClient
  return [
    defineServerTool({
      name: "browser_pointer",
      description:
        "Click or drag visual controls that have no usable snapshot ref. First inspect browser_screenshot and copy its screenshot_ref, tab_ref, profile_ref and origin. Coordinates are fractions of the whole image: x from left, y from top, each >=0 and <1. One screenshot permits one action; capture again after navigation, scrolling, resizing, zoom, takeover or another action. Prefer browser_act for accessible controls. Inspect the result; never blindly repeat an uncertain action.",
      parameters: Schema.toStandardSchemaV1(Parameters),
      metadata: {
        effect: "external",
        display_name: "Use visual browser control",
        kind: "browser",
        action: "execute",
        approval_preview: "Click or drag on this browser screenshot.",
        source: "_browser",
        changes_state: true,
        target: "reported",
        concurrency_group: "browser",
        destructive: false,
        default_approval: "ask",
        refuse_unattended: true,
        policy_scope: "external",
        open_world: true,
        idempotent: false
      },
      site: (input) => input.origin,
      approvalPrompt: async (input) => ({
        presentation: {
          title: "Allow browser pointer action?",
          fields: [
            { label: "Action", value: input.action },
            { label: APPROVAL_FIELD_LABEL.site, value: input.origin },
            { label: "Profile", value: input.profile_ref },
            { label: "Tab", value: input.tab_ref },
            { label: "Screenshot", value: input.screenshot_ref },
            {
              label: "Coordinates",
              value: JSON.stringify(
                input.action === "click" ? input.point : { from: input.from, to: input.to }
              )
            }
          ]
        },
        data: {
          origin: input.origin,
          ...uiTargetData(
            pointTarget(
              `A ${input.action} on screenshot ${input.screenshot_ref} at ${JSON.stringify(
                input.action === "click" ? input.point : { from: input.from, to: input.to }
              )}`
            )
          )
        }
      }),
      execute: async (input, ctx, effects) =>
        browserOutput(
          await runBrowserForRun(
            browser,
            ctx,
            {
              type: "pointer",
              tabRef: input.tab_ref,
              profileRef: input.profile_ref,
              origin: input.origin,
              screenshotRef: input.screenshot_ref,
              ...(input.action === "click"
                ? { action: "click", point: input.point }
                : { action: "drag", from: input.from, to: input.to })
            },
            ctx.signal,
            { effects }
          )
        )
    })
  ]
})
