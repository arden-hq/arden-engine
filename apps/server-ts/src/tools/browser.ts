import { ToolExecutionError } from "@arden-hq/loop"
import { PermissionRules } from "../persistence/permissions/rules.js"
import { Effect, Option, Schema } from "effect"
import {
  actApprovalPresentation,
  approvalTarget,
  decodeTargetSeen,
  targetLabel
} from "./browser-card.js"

import type { BrowserElement } from "./action-targets.js"
import { bodyFields } from "./code-mode-result.js"
import { DataRoot } from "../runtime/data-root.js"
import type { JsonObject } from "../persistence/json.js"
import { splitUiTarget } from "./ui-target.js"
import { defineServerTool, type ServerTool, type ServerToolMetadataInput } from "./define.js"
import { waivesRequirement } from "../execution/decide.js"
import { withBrowserProcedures } from "../browser/procedures/discovery.js"
import { BrowserProcedures } from "../browser/procedures/service.js"
import { PAGE_TEXT_MAX_CHARS } from "../persistence/browser-procedures/model.js"
import { INERT, OUTWARD } from "../execution/impact.js"
import { actImpact } from "./input-impact.js"
import { BrowserClient, type BrowserOutput } from "../browser/service.js"
import { ConversationArtifacts } from "../artifacts/conversation.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import type { LocalPathServices } from "../storage/local-paths.js"
import { localPages } from "./browser-local-page.js"
import { preserveBrowserScreenshot } from "./browser-screenshot.js"
import { readPage, withPageAfter, withPageRead } from "./browser-page.js"
import type { BrowserObservationRegistry, ServerRunContext } from "./run-context.js"
import {
  browserOutput,
  claimObservedRevision,
  requireObservedRevision,
  runBrowserForRun,
  TabRefSchema
} from "./browser-support.js"
import {
  ActParametersSchema,
  EmptyParametersSchema,
  OpenParametersSchema,
  ScreenshotParametersSchema,
  SnapshotParametersSchema,
  WaitParametersSchema
} from "./browser-parameters.js"

const isActionApproval = Schema.is(
  Schema.Struct({
    tab_ref: Schema.String,
    profile_ref: Schema.String,
    origin: Schema.String,
    action: Schema.String,
    expected_revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  })
)

const OpenedTabSchema = Schema.Struct({ tab: Schema.Struct({ tab_ref: Schema.String }) })

const openedTab = (output: BrowserOutput): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(OpenedTabSchema)(output.data))?.tab.tab_ref

const mayNavigate = (input: typeof ActParametersSchema.Type): boolean =>
  input.action === "click" ||
  input.action === "dblclick" ||
  input.action === "select" ||
  (input.action === "press" && /enter$/iu.test(input.value ?? ""))

const OPEN_METADATA = {
  effect: "external",
  display_name: "Open browser",
  kind: "browser",
  action: "execute",
  approval_preview: "Open a browser page.",
  source: "_browser",
  changes_state: true,
  target: "reported",
  concurrency_group: "browser",
  destructive: false,
  approval_bypass: true,
  refuse_unattended: true,
  policy_scope: "external",
  open_world: true,
  idempotent: false
} satisfies ServerToolMetadataInput

const makeBrowserTools = ({
  browser,
  artifacts,
  procedures,
  paths
}: {
  readonly browser: BrowserClient["Service"]
  readonly artifacts: ConversationArtifacts["Service"]
  readonly procedures: BrowserProcedures["Service"]
  readonly paths: LocalPathServices
}): ReadonlyArray<ServerTool> => {
  const local = localPages(paths)
  const observations = (run: ServerRunContext): BrowserObservationRegistry =>
    run.browserObservations
  return [
    defineServerTool({
      name: "browser_tabs",
      description: [
        "List browser tabs in the shared Space or Home browser, including refs, profiles, URLs, and selection state.",
        "Start here when a tab_ref, profile_ref, or current origin is unknown; use browser_snapshot to inspect page content."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
      metadata: {
        effect: "none",
        display_name: "Browser tabs",
        kind: "browser",
        action: "read",
        approval_preview: "List browser tabs.",
        source: "_browser",
        changes_state: false,
        concurrency_group: "browser",
        destructive: null,
        policy_scope: "external",
        open_world: true,
        idempotent: true
      },
      execute: async (_input, ctx) =>
        browserOutput(await runBrowserForRun(browser, ctx, { type: "tabs" }, ctx.signal, undefined))
    }),
    defineServerTool({
      name: "browser_open",
      description: [
        "Open a URL in a new tab or navigate one exact tab in the shared browser.",
        "A local HTML file opens in a tab that stays in the file's folder; a file outside the Local folders asks the user first.",
        "New tabs use profile_ref (default default); current navigation requires tab_ref and keeps that tab's profile.",
        "Navigation invalidates prior snapshots; set read to get the page in this call instead of a browser_snapshot."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(OpenParametersSchema),
      metadata: OPEN_METADATA,
      approvalRequirement: (input, ctx) => local.requirement(input.url, ctx),
      execute: async (input, ctx, effects) => {
        const url = await local.target(
          input.url,
          ctx,
          waivesRequirement(ctx.run.approvalMode, OPEN_METADATA)
        )
        if (input.tab_ref !== undefined) observations(ctx.run).forget(input.tab_ref, ctx.toolCallId)
        effects.unchanged()
        const opened = await runBrowserForRun(
          browser,
          ctx,
          {
            type: "open",
            url,
            disposition: input.disposition ?? "new",
            ...(input.tab_ref === undefined ? {} : { tabRef: input.tab_ref }),
            profileRef: input.profile_ref ?? "default"
          },
          ctx.signal
        )
        if (input.disposition !== "current") {
          const tab = openedTab(opened)
          if (tab !== undefined) observations(ctx.run).opened(tab)
        }
        return browserOutput(
          await withBrowserProcedures(
            procedures,
            await withPageRead(browser, ctx, opened, {
              tabRef: input.disposition === "current" ? input.tab_ref : undefined,
              read: input.read
            })
          )
        )
      }
    }),
    defineServerTool({
      name: "browser_close",
      description: [
        "Close one exact browser tab in the shared Space or Home browser after approval.",
        "Use browser_tabs first when the target ref is unclear."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(
        Schema.Struct({
          tab_ref: TabRefSchema.annotate({
            description: "Exact tab ref from browser_tabs or browser_open."
          })
        })
      ),
      metadata: {
        effect: "external",
        display_name: "Close browser tab",
        kind: "browser",
        action: "write",
        approval_preview: "Close this browser tab.",
        source: "_browser",
        changes_state: true,
        target: "reported",
        concurrency_group: "browser",
        destructive: true,
        default_approval: "ask",
        refuse_unattended: true,
        policy_scope: "external",
        open_world: true,
        idempotent: true
      },
      impact: (input, ctx) => (observations(ctx.run).openedHere(input.tab_ref) ? INERT : OUTWARD),
      approvalPrompt: async (input) => ({
        preview: `Close browser tab ${input.tab_ref}`,
        data: { tab_ref: input.tab_ref }
      }),
      execute: async (input, ctx, effects) => {
        observations(ctx.run).forget(input.tab_ref, ctx.toolCallId)
        return browserOutput(
          await runBrowserForRun(
            browser,
            ctx,
            { type: "close", tabRef: input.tab_ref },
            ctx.signal,
            { effects }
          )
        )
      }
    }),
    defineServerTool({
      name: "browser_snapshot",
      description: [
        "Read bounded page text or take an interactive snapshot with one-use @eN refs.",
        "Take an interactive snapshot before the first browser_act on a tab; each browser_act returns the next one. Each ends with a Snapshot ref, which the action built from it names. Use text for reading only.",
        "A wait, navigation, or action makes prior refs stale. Use browser_screenshot instead for visual evidence.",
        "To find something on a long page, set grep (a regular expression) to get only the matching lines with grep_context lines around them; refs it shows stay usable."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(SnapshotParametersSchema),
      metadata: {
        effect: "none",
        display_name: "Inspect browser",
        kind: "browser",
        action: "read",
        approval_preview: "Inspect this browser tab.",
        source: "_browser",
        changes_state: false,
        concurrency_group: "browser",
        destructive: null,
        policy_scope: "external",
        open_world: true,
        idempotent: true
      },
      execute: async (input, ctx) => {
        const value = await readPage(
          browser,
          ctx,
          {
            tabRef: input.tab_ref,
            mode: input.mode ?? "interactive",
            scope: input.scope,
            depth: input.depth,
            maxChars: input.max_chars ?? (input.grep === undefined ? PAGE_TEXT_MAX_CHARS : 50_000)
          },
          { remember: input.grep === undefined, grep: input.grep === undefined ? undefined : input }
        )
        ctx.run.codeMode.scriptFields(ctx.toolCallId, () => bodyFields(value.result))
        return browserOutput(await withBrowserProcedures(procedures, value))
      }
    }),
    defineServerTool({
      name: "browser_screenshot",
      description: [
        "Capture the visible part of one exact browser tab as PNG visual evidence and save a durable conversation artifact. For more of a long page, scroll with browser_act and capture again.",
        "Returns an image preview, artifact_ref, source URL, and capture time. Use artifact_export to copy it into project files; do not ask the user to save it manually.",
        "Use its one-use screenshot_ref with browser_pointer for visual click/drag. It does not authorize browser_act; take browser_snapshot for ref-based interaction."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(ScreenshotParametersSchema),
      metadata: {
        effect: "none",
        display_name: "Browser screenshot",
        kind: "browser",
        action: "read",
        approval_preview: "Capture this browser tab.",
        source: "_browser",
        changes_state: false,
        concurrency_group: "browser",
        destructive: null,
        policy_scope: "external",
        open_world: true,
        idempotent: true
      },
      execute: async (input, ctx) =>
        preserveBrowserScreenshot({
          output: await runBrowserForRun(
            browser,
            ctx,
            {
              type: "screenshot",
              tabRef: input.tab_ref,
              annotated: input.annotated ?? false
            },
            ctx.signal
          ),
          artifacts,
          sessionId: ctx.run.sessionId,
          runId: ctx.run.runId,
          toolCallId: ctx.toolCallId,
          signal: ctx.signal
        })
    }),
    defineServerTool({
      name: "browser_act",
      description: [
        "Perform exactly one browser action authorized by the latest interactive snapshot of the same tab.",
        "To enter a password, fill with secret (a name from browser_ask_secret), never value.",
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
        const state = observations(ctx.run)
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
                observations(ctx.run),
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
    }),
    defineServerTool({
      name: "browser_wait",
      description: [
        "Wait for one bounded condition on an exact browser tab.",
        "Waiting invalidates any prior action snapshot; set read to get the page in this call instead of a browser_snapshot."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(WaitParametersSchema),
      metadata: {
        effect: "none",
        display_name: "Wait for browser",
        kind: "browser",
        action: "read",
        approval_preview: "Wait for this browser condition.",
        source: "_browser",
        changes_state: false,
        concurrency_group: "browser",
        destructive: null,
        policy_scope: "external",
        open_world: true,
        idempotent: true
      },
      execute: async (input, ctx) => {
        const timeoutMs = input.timeout_ms ?? 30_000
        if (input.condition === "download") {
          return browserOutput(
            await runBrowserForRun(
              browser,
              ctx,
              { type: "wait", tabRef: input.tab_ref, condition: "download", timeoutMs },
              ctx.signal
            )
          )
        }
        if (input.value === undefined) {
          throw new ToolExecutionError(
            `browser_wait needs a value for condition ${input.condition}`,
            {
              preview: "Wait needs a value",
              retryable: false
            }
          )
        }
        observations(ctx.run).forget(input.tab_ref, ctx.toolCallId)
        const waited = await runBrowserForRun(
          browser,
          ctx,
          {
            type: "wait",
            tabRef: input.tab_ref,
            condition: input.condition,
            value: input.value,
            timeoutMs
          },
          ctx.signal
        )
        return browserOutput(
          await withPageRead(browser, ctx, waited, { tabRef: input.tab_ref, read: input.read })
        )
      }
    })
  ]
}

const actElement = (
  input: typeof ActParametersSchema.Type,
  ctx: { readonly run: ServerRunContext; readonly approval?: { readonly data?: JsonObject } }
): BrowserElement | undefined => {
  const target = input.target
  if (target?.node_ref === undefined) return undefined
  const carded = splitUiTarget(ctx.approval?.data).target
  const label =
    carded?.kind === "element"
      ? carded.label
      : ctx.run.browserObservations.describe(input.tab_ref, target.node_ref)
  return targetLabel(label)
}

export const browserTools = Effect.gen(function* () {
  return makeBrowserTools({
    browser: yield* BrowserClient,
    artifacts: yield* ConversationArtifacts,
    procedures: yield* BrowserProcedures,
    paths: {
      spaces: yield* SpaceStore,
      sessions: yield* SessionQueries,
      runs: yield* RunQueries,
      rules: yield* PermissionRules,
      dataDir: (yield* DataRoot).dir
    }
  })
})
