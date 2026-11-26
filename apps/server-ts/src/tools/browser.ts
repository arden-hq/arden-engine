import { ToolExecutionError } from "@arden-hq/loop"
import { PermissionRules } from "../persistence/permissions/rules.js"
import { Effect, Option, Schema } from "effect"

import { bodyFields } from "./code-mode-result.js"
import { DataRoot } from "../runtime/data-root.js"
import { defineServerTool, type ServerTool, type ServerToolMetadataInput } from "./define.js"
import { waivesRequirement } from "../execution/decide.js"
import { withBrowserProcedures } from "../browser/procedures/discovery.js"
import { BrowserProcedures } from "../browser/procedures/service.js"
import { PAGE_TEXT_MAX_CHARS } from "../persistence/browser-procedures/model.js"
import { INERT, OUTWARD } from "../execution/impact.js"
import { BrowserClient, type BrowserOutput } from "../browser/service.js"
import { ConversationArtifacts } from "../artifacts/conversation.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import type { LocalPathServices } from "../storage/local-paths.js"
import { localPages } from "./browser-local-page.js"
import { preserveBrowserScreenshot } from "./browser-screenshot.js"
import { readPage, withPageRead } from "./browser-page.js"
import { browserOutput, runBrowserForRun, TabRefSchema } from "./browser-support.js"
import {
  EmptyParametersSchema,
  OpenParametersSchema,
  ScreenshotParametersSchema,
  SnapshotParametersSchema,
  WaitParametersSchema
} from "./browser-parameters.js"
import { makeBrowserActTool } from "./browser-act.js"
import type { BrowserObservationRegistry, ServerRunContext } from "./run-context.js"

const OpenedTabSchema = Schema.Struct({ tab: Schema.Struct({ tab_ref: Schema.String }) })

const openedTab = (output: BrowserOutput): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(OpenedTabSchema)(output.data))?.tab.tab_ref

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
      summary: "Lists the pages open in Arden’s browser.",
      discovery: { group: "web_browser" },
      description: [
        "List browser tabs in this chat's shared browser, including refs, profiles, URLs, and selection state.",
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
      summary: "Opens a page in Arden’s browser.",
      discovery: { group: "web_browser" },
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
      summary: "Closes a page in Arden’s browser.",
      discovery: { group: "web_browser" },
      description: [
        "Close one exact browser tab in this chat's shared browser.",
        "Closing a tab this run opened needs no approval; any other tab asks the user first.",
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
      summary: "Reads what is on a browser page.",
      discovery: { group: "web_browser" },
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
      summary: "Takes a picture of a browser page.",
      discovery: { group: "web_browser" },
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
          signal: ctx.signal,
          imageInput: ctx.run.imageInput
        })
    }),
    makeBrowserActTool(browser),
    defineServerTool({
      name: "browser_wait",
      summary: "Waits for a browser page to load, change, show something, or finish a download.",
      discovery: { group: "web_browser" },
      description: [
        "Wait for one bounded condition on an exact browser tab: page load, URL, visible text, element, elapsed time, or a finished download.",
        "Except for download, waiting invalidates any prior action snapshot; set read to get the page in this call instead of a browser_snapshot. A download wait keeps refs and ignores read."
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
