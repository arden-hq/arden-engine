import { Option, Schema } from "effect"
import {
  actApprovalPresentation,
  approvalTarget,
  decodeTargetSeen,
  targetLabel
} from "./browser-card.js"

import type { BrowserElement } from "./action-targets.js"
import type { JsonObject } from "../persistence/json.js"
import { splitUiTarget, UI_TARGET } from "./ui-target.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { actImpact } from "./input-impact.js"
import { BROWSER_ACT_ACTION, BrowserClient } from "../browser/service.js"
import { withPageAfter } from "./browser-page.js"
import type { ServerRunContext } from "./run-context.js"
import {
  browserOutput,
  claimObservedRevision,
  requireObservedRevision,
  runBrowserForRun
} from "./browser-support.js"
import { ActParametersSchema } from "./browser-parameters.js"

const isActionApproval = Schema.is(
  Schema.Struct({
    tab_ref: Schema.String,
    profile_ref: Schema.String,
    origin: Schema.String,
    action: Schema.String,
    expected_revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  })
)
const mayNavigate = (input: typeof ActParametersSchema.Type): boolean =>
  input.action === BROWSER_ACT_ACTION.click ||
  input.action === BROWSER_ACT_ACTION.dblclick ||
  input.action === BROWSER_ACT_ACTION.select ||
  (input.action === BROWSER_ACT_ACTION.press && /enter$/iu.test(input.value ?? ""))
const actElement = (
  input: typeof ActParametersSchema.Type,
  ctx: { readonly run: ServerRunContext; readonly approval?: { readonly data?: JsonObject } }
): BrowserElement | undefined => {
  const target = input.target
  if (target?.node_ref === undefined) return undefined
  const carded = splitUiTarget(ctx.approval?.data).target
  const label =
    carded?.kind === UI_TARGET.element
      ? carded.label
      : ctx.run.browserObservations.describe(input.tab_ref, target.node_ref)
  return targetLabel(label)
}
export const makeBrowserActTool = (browser: BrowserClient["Service"]): ServerTool => {
  return defineServerTool({
    name: "browser_act",
    summary: "Clicks, types and scrolls on a browser page.",
    discovery: { group: "web_browser" },
    description: [
      "Perform exactly one browser action authorized by the latest interactive snapshot of the same tab.",
      "To enter a password, fill with secret (a name from browser_ask_secret), never value. A saved card is typed only by vault_checkout, never with value.",
      "The tab's profile and origin must still match; once an approved action begins, its snapshot is consumed even if execution fails.",
      "It returns the page after the action as a fresh interactive snapshot, which authorizes the next browser_act; do not take another one.",
      "If the outcome is unknown, inspect before retrying."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ActParametersSchema),
    impact: actImpact,
    site: (input) => input.origin,
    metadata: {
      effect: "external",
      display_name: "Use browser",
      kind: "browser",
      action: "execute",
      approval_preview: "Perform this browser action.",
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
    approvalPrompt: async (input, ctx) => {
      const state = ctx.run.browserObservations
      const nodeRef = input.target?.node_ref
      const described = nodeRef === undefined ? undefined : state.describe(input.tab_ref, nodeRef)
      const seen =
        nodeRef === undefined
          ? undefined
          : await runBrowserForRun(
              browser,
              ctx,
              { type: "target", tabRef: input.tab_ref, nodeRef },
              ctx.signal
            ).then(
              (output) => Option.getOrUndefined(decodeTargetSeen(output.data)),
              () => undefined
            )
      return {
        presentation: actApprovalPresentation(input, targetLabel(described), seen),
        data: {
          tab_ref: input.tab_ref,
          profile_ref: input.profile_ref,
          origin: input.origin,
          action: input.action,
          expected_revision: claimObservedRevision(
            state,
            input.tab_ref,
            input.snapshot_ref,
            ctx.toolCallId
          ),
          ...approvalTarget(input, described, seen)
        }
      }
    },
    execute: async (input, ctx, effects) => {
      const element = actElement(input, ctx)
      const approved = ctx.approval?.data
      const approvedRevision =
        isActionApproval(approved) &&
        approved.tab_ref === input.tab_ref &&
        approved.profile_ref === input.profile_ref &&
        approved.origin === input.origin &&
        approved.action === input.action
          ? approved.expected_revision
          : undefined
      const expectedRevision =
        ctx.approval === undefined
          ? claimObservedRevision(
              ctx.run.browserObservations,
              input.tab_ref,
              input.snapshot_ref,
              ctx.toolCallId
            )
          : requireObservedRevision(approvedRevision)
      const target =
        input.target === undefined
          ? undefined
          : {
              ...(input.target.node_ref === undefined ? {} : { nodeRef: input.target.node_ref }),
              ...(input.target.kind === undefined ? {} : { kind: input.target.kind }),
              ...(input.target.value === undefined ? {} : { value: input.target.value }),
              ...(input.target.name === undefined ? {} : { name: input.target.name }),
              exact: input.target.exact ?? false
            }
      const acted = await runBrowserForRun(
        browser,
        ctx,
        {
          type: "act",
          tabRef: input.tab_ref,
          profileRef: input.profile_ref,
          origin: input.origin,
          expectedRevision,
          action: input.action,
          ...(target === undefined ? {} : { target }),
          ...(input.value === undefined ? {} : { value: input.value }),
          ...(input.secret === undefined ? {} : { secret: input.secret }),
          ...(input.values === undefined ? {} : { values: input.values }),
          ...(input.direction === undefined ? {} : { direction: input.direction }),
          ...(input.amount === undefined ? {} : { amount: input.amount })
        },
        ctx.signal,
        { effects, ...(element === undefined ? {} : { element }) }
      )
      return browserOutput(
        await withPageAfter(browser, ctx, acted, {
          tabRef: input.tab_ref,
          after: input.snapshot,
          navigates: mayNavigate(input)
        })
      )
    }
  })
}
