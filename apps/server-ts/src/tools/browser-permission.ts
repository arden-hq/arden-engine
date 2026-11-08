import { listWords } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { APPROVAL_FIELD_LABEL, type ChatApprovalMode } from "@arden-hq/protocol/chat"
import { Effect, Schema } from "effect"

import {
  BrowserClient,
  SitePermissionRequestRefSchema,
  SitePermissionSchema,
  type SitePermission
} from "../browser/service.js"
import {
  browserOutput,
  OriginSchema,
  originIssues,
  runBrowserForRun,
  TabRefSchema
} from "./browser-support.js"
import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import { personCard } from "../execution/decide.js"
import { DECISION_WORD } from "@arden-hq/protocol/permissions"

const PermissionParametersSchema = Schema.Struct({
  tab_ref: TabRefSchema.annotate({
    description: "The tab the permission request came from, as the browser tool result named it."
  }),
  request_ref: SitePermissionRequestRefSchema.annotate({
    description: "The request id from that result."
  }),
  origin: OriginSchema.annotate({
    description: "The origin that asked, exactly as the result named it."
  }),
  permissions: Schema.Array(SitePermissionSchema)
    .check(Schema.isMinLength(1), Schema.isMaxLength(3))
    .annotate({ description: "Every permission the page asked for, as the result listed them." })
}).check(Schema.makeFilter((input) => originIssues(input.origin)))

type SitePermissionDecision =
  | { readonly kind: "ask" }
  | { readonly kind: "answer"; readonly answer: "once" | "always" }
  | { readonly kind: "deny"; readonly reason: "deferred" | "never_ask" | "read_only" }

export const sitePermissionDecision = (input: {
  readonly mode: ChatApprovalMode
  readonly permissions: ReadonlyArray<SitePermission>
  readonly approval: { readonly always: boolean } | undefined
}): SitePermissionDecision => {
  if (input.permissions.some((permission) => permission !== "location")) {
    return { kind: "deny", reason: "deferred" }
  }
  if (input.approval !== undefined) {
    return { kind: "answer", answer: input.approval.always ? "always" : "once" }
  }
  const card = personCard(input.mode)
  return card === "ask" ? { kind: "ask" } : { kind: "deny", reason: card }
}

const permissionCard = (input: typeof PermissionParametersSchema.Type): ServerApprovalPrompt => {
  const site = new URL(input.origin).host
  const words = listWords(input.permissions)
  return {
    preview: `${site} asks to use your ${words}`,
    presentation: {
      title: `Let ${site} use your ${words}?`,
      fields: [{ label: APPROVAL_FIELD_LABEL.site, value: input.origin }],
      approve_label: DECISION_WORD.allowOnce,
      reject_label: DECISION_WORD.deny
    },
    data: { reviewer: "user" }
  }
}

const DENIAL: Record<Extract<SitePermissionDecision, { kind: "deny" }>["reason"], string> = {
  deferred: "Denied: Arden's browser does not give sites the camera or microphone.",
  never_ask:
    "Denied: in Never ask, Arden does not turn on location for a site. Carry on without it; the user can allow it in the browser with Take control.",
  read_only: "Denied: this run may not change anything."
}

const makeBrowserPermissionTool = (browser: BrowserClient["Service"]): ServerTool =>
  defineServerTool({
    name: "browser_permission",
    description: [
      "Ask the user to let a page in an Arden browser tab use the location.",
      "Call it only when a browser tool result reports a Permission request and the task needs it; pass its tab, request, origin and permissions exactly.",
      "The user answers on a card: allow once, always for this site, or deny.",
      "A request you leave alone is denied when the page stops waiting."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(PermissionParametersSchema),
    metadata: {
      display: { card: "site_grant" },
      effect: "external",
      display_name: "Site permission",
      kind: "browser",
      action: "execute",
      approval_preview: "Let this site use your location.",
      source: "_browser",
      changes_state: true,
      target: "reported",
      concurrency_group: "browser",
      destructive: false,
      default_approval: "ask",
      approval_bypass: true,
      refuse_unattended: true,
      policy_scope: "external",
      open_world: true,
      idempotent: false,
      code_mode: false
    },
    approvalRequirement: (input, ctx) => {
      const decision = sitePermissionDecision({
        mode: ctx.run.approvalMode,
        permissions: input.permissions,
        approval: undefined
      })
      return decision.kind === "ask" ? permissionCard(input) : undefined
    },
    execute: async (input, ctx, effects) => {
      const decision = sitePermissionDecision({
        mode: ctx.run.approvalMode,
        permissions: input.permissions,
        approval:
          ctx.approval === undefined ? undefined : { always: ctx.approval.grantStanding === true }
      })
      if (decision.kind === "deny" && decision.reason === "deferred") {
        throw new ToolExecutionError(DENIAL.deferred, {
          preview: DECISION_WORD.denied,
          retryable: false
        })
      }
      if (decision.kind === "ask") {
        throw new ToolExecutionError("A site permission is answered only on the user's card.", {
          preview: "Needs approval",
          retryable: false
        })
      }
      const output = await runBrowserForRun(
        browser,
        ctx,
        {
          type: "permission",
          tabRef: input.tab_ref,
          requestRef: input.request_ref,
          origin: input.origin,
          permissions: input.permissions,
          answer: decision.kind === "answer" ? decision.answer : "deny"
        },
        ctx.signal,
        { effects }
      )
      return decision.kind === "deny"
        ? { ...browserOutput(output), result: DENIAL[decision.reason] }
        : browserOutput(output)
    }
  })

export const browserPermissionTools = Effect.gen(function* () {
  return [makeBrowserPermissionTool(yield* BrowserClient)]
})
