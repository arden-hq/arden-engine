import { countOf } from "@arden-hq/std/count"
import { defineServerTool, type ServerTool } from "./define.js"
import { EmptyParametersSchema } from "./automation-tool-schema.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { utcDay } from "@arden-hq/std/time"
import { DateTime, Effect, Option, Schema } from "effect"
import { usageGroup } from "@arden-hq/protocol/runs"
import { effectiveBackgroundLimit } from "@arden-hq/protocol/settings"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { UsageStore } from "../persistence/usage/store.js"
import { IntelligenceSettingsStore, LimitSettingsStore } from "../persistence/settings/store.js"
import { ModelProviderService } from "../models/provider.js"
import { currentPlanReading, planLimitsReport } from "../models/plan-limits.js"
import { WorkerStatus } from "../automations/worker-status.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { runInspectTool } from "./run-inspection.js"
import { currentMillis } from "../runtime/clock.js"

interface Services {
  readonly automations: AutomationCatalog["Service"]
  readonly usage: UsageStore["Service"]
  readonly settings: IntelligenceSettingsStore["Service"]
  readonly workerStatus: WorkerStatus["Service"]
  readonly runs: RunQueries["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly limits: LimitSettingsStore["Service"]
  readonly models: ModelProviderService["Service"] | undefined
}

const metadata = {
  kind: "tool",
  action: "read",
  source: "_system",
  changes_state: false,
  concurrency_group: null,
  destructive: false
} as const

const makeInternalStateTools = (services: Services): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "automation_diagnose",
    description:
      "Inspect live shared worker capacity, queue leases/retries, overdue schedules and active chats. Optionally focus on an exact automation_ref from automation_list or page context. Tasks, Space workers, Automations and system jobs share this pool; sub-agents use a separate limit. Diagnose before proposing a schedule reset. Overdue alone does not prove stopped dispatch; report unknown causes as unknown. Read recent outcomes with automation_list_runs and linked runs with run_inspect.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        automation_ref: Schema.optionalKey(
          Schema.NonEmptyString.check(Schema.isMaxLength(200)).annotate({
            description:
              "Exact automation_ref from automation_list or the selected page. Omit for a pool overview."
          })
        )
      })
    ),
    metadata: {
      effect: "none",
      ...metadata,
      display_name: "Inspect Automation State",
      approval_preview: "Check how agents and automations are running."
    },
    execute: async (input, ctx) => {
      const [diagnostics, settings, paused] = await Promise.all([
        Effect.runPromise(services.automations.diagnostics(input.automation_ref), {
          signal: ctx.signal
        }),
        Effect.runPromise(services.settings.settings(), { signal: ctx.signal }),
        Effect.runPromise(services.runs.planLimitPauses(), { signal: ctx.signal })
      ])
      const live = services.workerStatus.read()
      const report = {
        ...diagnostics,
        waiting_on_plan_limit: paused.map((run) => ({
          run_id: run.runId,
          automation_id: run.automationId,
          reason: run.reason,
          resumes_at: run.until
        })),
        configured_worker_limit: settings.maxConcurrentWorkers,
        subagent_limit: settings.maxConcurrentAgents,
        worker:
          live === undefined
            ? { state: "unavailable" }
            : {
                state: "observed",
                running: live.running,
                active_count: live.activeCount,
                effective_capacity: live.capacity ?? null,
                last_admit_at:
                  live.lastAdmitAt === undefined
                    ? null
                    : DateTime.formatIso(DateTime.makeUnsafe(live.lastAdmitAt)),
                last_claim_at:
                  live.lastClaimAt === undefined
                    ? null
                    : DateTime.formatIso(DateTime.makeUnsafe(live.lastClaimAt)),
                next_wake_at:
                  live.nextWakeAt === undefined
                    ? null
                    : DateTime.formatIso(DateTime.makeUnsafe(live.nextWakeAt)),
                active_queue_ids: live.activeJobIds
              },
        interpretation: [
          "Queue counts cover the whole shared pool; lists are bounded and prioritize the selected automation.",
          "Runs in waiting_on_plan_limit are paused on the user's plan limits, not stuck: they resume by themselves at resumes_at, and their jobs look again within 15 minutes. Read usage_limits for the plan and limits.",
          "A valid lease is recorded ownership, not proof of progress. Live worker observations are separate from the database snapshot.",
          "No free slots means work waits. A free slot does not prove eligibility: retry delay, same-job execution, active destination chat, disabled schedule, or a pending Task question can block admission.",
          "Manual runs can execute while a schedule is paused. Due schedules may not have queue rows until capacity is available.",
          "The worker does not poll: it admits when work is queued or changes, and otherwise sleeps until next_wake_at (the earliest due job, at most a minute away). last_claim_at is the latest completed admission query, even if it claimed no jobs. No heartbeat or old heartbeat means state is unknown; do not invent a stopped-scheduler diagnosis."
        ]
      }
      return {
        result: JSON.stringify(report),
        preview: `${diagnostics.queue_counts.total} queued or leased jobs`
      }
    }
  }),
  defineServerTool({
    name: "usage_limits",
    description:
      "Read the model plan and available Codex credits: each window's percent used and reset time, its pace against the Arden limit, the provider-reported credit balance, the user's limits (Arden limit, background limit, keep going until, per-Automation limits) and the Runs waiting on a limit. The percent and credits are the provider's own meter, shared with Codex CLI and ChatGPT on the same account; never convert Arden's tokens into them. A waiting Run is paused, not stuck or failed, and resumes when its limit allows. Use usage_report for token history.",
    parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
    metadata: {
      effect: "none",
      ...metadata,
      display_name: "Read Plan Limits",
      approval_preview: "Read the plan's limits and what waits on them."
    },
    execute: async (_input, ctx) => {
      const now = currentMillis()
      const source = services.models?.current()?.planLimits
      const reading = source === undefined ? undefined : await currentPlanReading(source, now)
      const [settings, paused] = await Effect.runPromise(
        Effect.all([services.limits.settings(), services.runs.planLimitPauses()]),
        { signal: ctx.signal }
      )
      const arden = settings.ardenLimitPercent
      const report = {
        ...planLimitsReport(reading, source?.history() ?? [], arden ?? 100, now),
        limits: {
          arden_limit_percent: arden,
          background_limit_percent: effectiveBackgroundLimit(settings),
          keep_going_until:
            settings.keepGoingUntil !== null && Date.parse(settings.keepGoingUntil) > now
              ? settings.keepGoingUntil
              : null,
          automation_limits: settings.automationLimits
        },
        paused_runs: paused.map((run) => ({
          run_id: run.runId,
          session_id: run.sessionId,
          reason: run.reason,
          until: run.until,
          automation_id: run.automationId
        })),
        interpretation: [
          "Chats and Tasks stop at the Arden limit unless keep_going_until is set. Available Codex credits allow work past 100% only when its stops allow it; without available credits it waits for the reset. A null limit means Never. Background work can use credits when both the Arden and background limits are null; an Automation's own lower limit still applies. keep_going_until only bypasses the Arden limit for chats.",
          "The limits are the user's settings in Settings > Usage. Suggest a change; never claim to have made one.",
          "plans is empty when no provider with a plan meter is connected: say the plan cannot be read, not that it is unused."
        ]
      }
      const first = report.plans[0]?.windows[0]
      return {
        result: JSON.stringify(report),
        preview:
          first === undefined
            ? "No plan reading"
            : `${first.used_percent}% used, ${paused.length} waiting`
      }
    }
  }),
  defineServerTool({
    name: "usage_report",
    description:
      "Read Arden's recorded token usage by UTC calendar days, with totals, daily totals, top groups, sessions and automations. Use through_day for historical or page-selected windows. Includes usage receipts from unfinished/failed runs when available. Tokens are not billed money or subscription quota; cache reads may be cheaper but are not necessarily free. cache_read_percent_of_input is cache-read tokens divided by all recorded input tokens, not a provider cache hit rate. Arden does not record reasoning tokens separately. Use session_read and run_inspect before claiming why usage was high. Empty data means no recorded usage, not proven zero spending.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })).pipe(
          Schema.withDecodingDefault(Effect.succeed(7)),
          Schema.annotateEncoded({
            description:
              "Number of UTC calendar days ending on through_day, from 1 to 365. Defaults to 7."
          })
        ),
        through_day: Schema.optionalKey(
          Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
            description: "Inclusive final UTC date, YYYY-MM-DD. Defaults to today in UTC."
          })
        ),
        group_by: Schema.Literals(["model", "space", "kind", "origin"]).pipe(
          Schema.withDecodingDefault(Effect.succeed("space")),
          Schema.annotateEncoded({
            description:
              "Rank by model, space, kind (chats, automations, upkeep, safety), or user/automation origin. Defaults to space."
          })
        )
      })
    ),
    metadata: {
      effect: "none",
      ...metadata,
      display_name: "Read Usage",
      approval_preview: "Read recorded token usage."
    },
    execute: async (input, ctx) => {
      const report = await Effect.runPromise(
        services.usage.report({
          days: input.days,
          ...(input.through_day === undefined ? {} : { throughDay: input.through_day })
        }),
        { signal: ctx.signal }
      )
      const totals = {
        tokens: 0,
        input: 0,
        uncached_input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        runs: 0,
        model_calls: 0
      }
      const groups = new Map<string, typeof totals>()
      const daily = new Map<string, number>()
      for (const row of report.daily) {
        const key = (() => {
          switch (input.group_by) {
            case "model":
              return row.model_id ?? "Unknown model"
            case "space":
              return row.space_id ?? "Personal"
            case "kind":
              return usageGroup(row.kind, row.origin)
            case "origin":
              return row.origin
          }
        })()
        const group = groups.get(key) ?? {
          tokens: 0,
          input: 0,
          uncached_input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          runs: 0,
          model_calls: 0
        }
        for (const target of [totals, group]) {
          target.tokens += row.total
          target.input += row.total - row.output
          target.uncached_input += row.total - row.output - row.cache_read
          target.output += row.output
          target.cache_read += row.cache_read
          target.cache_write += row.cache_write
          if (row.kind === "chat") target.runs += row.runs
          else target.model_calls += row.runs
        }
        groups.set(key, group)
        daily.set(row.day, (daily.get(row.day) ?? 0) + row.total)
      }
      const ranked = [...groups].sort((a, b) => b[1].tokens - a[1].tokens)
      return {
        result: JSON.stringify({
          observed_at: DateTime.formatIso(await Effect.runPromise(DateTime.now)),
          timezone: "UTC",
          since: report.since,
          days: report.days,
          through_day: utcDay(
            DateTime.toEpochMillis(
              DateTime.add(DateTime.makeUnsafe(`${report.since}T00:00:00Z`), {
                days: report.days - 1
              })
            )
          ),
          money: {
            state: "unavailable",
            reason: "This report measures tokens, not billed cost or subscription limits."
          },
          totals: {
            ...totals,
            cache_read_percent_of_input:
              totals.input === 0
                ? null
                : Math.round((totals.cache_read / totals.input) * 1_000) / 10
          },
          group_by: input.group_by,
          groups: ranked.slice(0, 20).map(([key, values]) => ({
            key,
            ...values,
            cache_read_percent_of_input:
              values.input === 0
                ? null
                : Math.round((values.cache_read / values.input) * 1_000) / 10
          })),
          groups_has_more: ranked.length > 20,
          daily: [...daily].map(([day, tokens]) => ({ day, tokens })),
          top_sessions: report.top_sessions,
          automations: report.automations,
          coverage:
            "Daily totals survive trace retention; session and automation breakdowns cover retained runs only and are limited to the top 12. average_last_input is the mean final model input per Run, not total tokens per Run or mean input across every model step. Missing provider receipts cannot be counted."
        }),
        preview: countOf(totals.tokens, "recorded token")
      }
    }
  }),
  runInspectTool({ runs: services.runs, sessions: services.sessions })
]

export const internalStateTools = Effect.gen(function* () {
  return makeInternalStateTools({
    automations: yield* AutomationCatalog,
    usage: yield* UsageStore,
    settings: yield* IntelligenceSettingsStore,
    workerStatus: yield* WorkerStatus,
    runs: yield* RunQueries,
    sessions: yield* SessionQueries,
    limits: yield* LimitSettingsStore,
    models: Option.getOrUndefined(yield* Effect.serviceOption(ModelProviderService))
  })
})
