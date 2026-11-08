import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../wiki/authority.js"
import { directorySections } from "../wiki/collections.js"
import { WikiReportContentSchema } from "../wiki/reports.js"
import { Wiki } from "../wiki/service.js"
import { resolveAutomation } from "./automation-records.js"
import { loadSnapshot, wikiFailure, writtenPageData } from "./wiki.js"
import { readRunCause, readWikiRun } from "./wiki-identity.js"
import { recordApplied } from "../execution/tool-effect.js"
import { directoryReceipt, pageReceipt } from "./wiki-records.js"

interface Services {
  readonly wiki: Wiki["Service"]
  readonly runs: RunQueries["Service"]
  readonly automations: AutomationCatalog["Service"]
}

const makeWikiReportTools = (services: Services): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "wiki_configure_reports",
    description:
      "Bind an empty Memory directory to one personal Automation for managed reports. " +
      "Run during user-requested setup, after automation_create with enabled=false. Enable with automation_update only after configuration succeeds. Reuse its existing destination or choose sources/<workflow>. " +
      "The parent must exist. Repeating identical setup is safe; existing unrelated pages or producers are never claimed. " +
      "Save instructions to use wiki_publish_report in that Automation's prompt. Asks by default.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        automation_ref: Schema.NonEmptyString.annotate({
          description: "Exact automation_ref from automation_create or automation_list."
        }),
        directory: Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
          description: "Relative directory without trailing slash, such as sources/activity."
        }),
        contract: Schema.NonEmptyString.check(Schema.isMaxLength(40_000)).annotate({
          description:
            "Complete README with nonempty ## Purpose, ## Producers, ## Consumers, ## Boundaries, ## Retention and ## Records sections. Records specifies filename/date/timezone and evidence lookup conventions."
        })
      })
    ),
    metadata: {
      effect: "arden_db",
      display_name: "Configure Memory Reports",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Choose where this automation's Memory report goes.",
      source: "_wiki",
      changes_state: true,
      target: "reported",
      concurrency_group: "wiki_write",
      destructive: false
    },
    execute: async (input, ctx, effects) => {
      if (
        (await readWikiRun(services.runs, { ...ctx.run, signal: ctx.signal })).context.origin
          .kind !== "chat"
      ) {
        throw new ToolExecutionError(
          "Configure report destinations in the user's setup conversation",
          {
            preview: "Report setup requires a user Chat",
            retryable: false
          }
        )
      }
      if (!directorySections(input.contract).get("Records")) {
        throw new ToolExecutionError("The contract needs a nonempty ## Records section", {
          preview: "Missing record conventions",
          retryable: false
        })
      }
      const automation = await resolveAutomation(
        services.automations,
        input.automation_ref,
        ctx.signal
      )
      const result = await recordApplied(
        effects,
        Effect.runPromise(
          services.wiki
            .createDirectory({
              path: input.directory,
              body: input.contract,
              producerAutomationId: automation.task_id,
              authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
              commit: {
                actor: "Agent",
                origin: { kind: "agent", sessionId: ctx.run.sessionId },
                reason: `Configure reports for ${automation.name}`
              }
            })
            .pipe(Effect.mapError(wikiFailure)),
          { signal: ctx.signal }
        )
      )
      return {
        result:
          `Report destination: ${input.directory}. Contract: ${result.page.path}. ` +
          `Use wiki_publish_report from ${automation.name}; include period, original source references and meaningful subject links.`,
        preview: result.changed ? "Report destination configured" : "Report destination unchanged",
        data: { page: writtenPageData(result.page), changed: result.changed },
        ...(result.changed ? { host: directoryReceipt(ctx, result.page) } : {})
      }
    }
  }),
  defineServerTool({
    name: "wiki_publish_report",
    description:
      "Publish a dated report in this Automation's configured Memory destination. " +
      "Adds stable identity, revisions, source metadata, search and change events. Identical retries are unchanged; " +
      "read an existing report before revising it. Only the admitted producer can publish; filenames do not grant authority. Preauthorized by Read + save reports; other profiles may require approval.",
    parameters: Schema.toStandardSchemaV1(
      WikiReportContentSchema.mapFields((fields) => ({
        path: fields.path.annotate({
          description:
            "Exact .md path directly inside this Automation's configured report directory; follow its Records convention."
        }),
        title: fields.title.annotate({
          description: "Short human-readable title including the report date or period."
        }),
        body: fields.body.annotate({
          description:
            "Useful Markdown summary with meaningful subject wikilinks, exact source pointers, uncertainty and coverage gaps. Never invent activity or copy raw logs."
        }),
        period: fields.period.annotate({
          description:
            "Actual observation interval as ISO timestamps with explicit offsets. The server stores one UTC interval; do not include publication time or duplicate timezone conversions."
        }),
        sources: fields.sources.annotate({
          description:
            "One to thirty exact original source references (URLs, Chat references or source record identifiers). Never fabricate references."
        })
      }))
    ),
    metadata: {
      effect: "arden_db",
      display_name: "Publish Memory Report",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Publish this Automation's sourced Memory report.",
      source: "_wiki",
      scopes: ["reports"],
      unattended_scope: "reports",
      changes_state: true,
      target: "reported",
      concurrency_group: "wiki_write",
      destructive: false
    },
    execute: async (input, ctx, effects) => {
      const {
        context: { origin }
      } = await readWikiRun(services.runs, { ...ctx.run, signal: ctx.signal })
      const cause = await readRunCause(services.runs, { ...ctx.run, signal: ctx.signal })
      if (origin.kind !== "automation" || cause.automationId === undefined) {
        throw new ToolExecutionError("Only an Automation run can publish its managed report", {
          preview: "No report producer",
          retryable: false
        })
      }
      const snapshot = await loadSnapshot(services.wiki, ctx.signal)
      const existing = snapshot.pages.find((page) => page.resource.path === input.path)
      const result = await recordApplied(
        effects,
        Effect.runPromise(
          services.wiki
            .publishReport({
              ...input,
              producerAutomationId: cause.automationId,
              producerChainDepth: cause.wakeDepth,
              runId: ctx.run.runId,
              expectedVersion:
                existing === undefined
                  ? undefined
                  : ctx.run.observations.observed(existing.page.pageId)
            })
            .pipe(Effect.mapError(wikiFailure)),
          { signal: ctx.signal }
        )
      )
      ctx.run.observations.observe(result.page.pageId, result.page.version)
      return {
        result: `${result.changed ? "Published" : "Unchanged"} report: ${result.page.path}`,
        preview: result.changed ? "Memory report published" : "Memory report unchanged",
        data: { page: writtenPageData(result.page), changed: result.changed },
        ...(result.changed
          ? {
              host: pageReceipt({
                ctx,
                page: result.page,
                beforeVersion: existing?.resource.versionId ?? "absent"
              })
            }
          : {})
      }
    }
  })
]

export const wikiReportTools = Effect.gen(function* () {
  return makeWikiReportTools({
    wiki: yield* Wiki,
    runs: yield* RunQueries,
    automations: yield* AutomationCatalog
  })
})
