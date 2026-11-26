import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { AUTOMATION_WRITE_TOOL } from "../persistence/automations/tool-names.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { assertAppEvents } from "./automation-app-events.js"
import { McpConnections } from "../mcp/service.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { AutomationId } from "../persistence/automations/model.js"
import { AutomationQueue } from "../persistence/automations/queue.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { SessionStore } from "../persistence/sessions/store.js"
import { ModelStore } from "../persistence/models/store.js"
import { LimitSettingsStore } from "../persistence/settings/store.js"
import { ApprovalPolicyStore } from "../persistence/permissions/approval-policy.js"
import {
  CreateParametersSchema,
  EmptyParametersSchema,
  RefParametersSchema,
  RunsParametersSchema
} from "./automation-tool-schema.js"
import { requireResult } from "./tool-failure.js"
import {
  CREATE_APPROVAL_EDITS,
  createCardOf,
  createChatWhere,
  createConflict,
  promptWriterOf
} from "./automation-create-card.js"
import {
  chatLabel,
  formatAutomation,
  modelLabel,
  historyLabel,
  scheduleStatus,
  automationRunLines,
  triggersLabel
} from "./automation-tool-text.js"
import { recordApplied } from "../execution/tool-effect.js"
import { createRequestOf } from "./automation-tool-requests.js"
import { automationData, isRunning, nextRunAt } from "./automation-tool-data.js"
import { appliedReceipt } from "./call-receipt.js"
import {
  automationResource,
  deletedAutomationResource,
  lastAutomationVersion,
  resolveAutomation,
  storeFailure
} from "./automation-records.js"
import {
  type AutomationToolServices,
  automationGuards,
  automationModelInfo,
  chosenChat
} from "./automation-tool-support.js"
import { makeAutomationUpdateTool } from "./automation-update-tool.js"

const makeAutomationTools = (services: AutomationToolServices): ReadonlyArray<ServerTool> => {
  const createCard = createCardOf({ models: services.models })
  return [
    defineServerTool({
      name: AUTOMATION_WRITE_TOOL.create,
      summary: "Sets up a new automation.",
      discovery: { group: "automations" },
      description: [
        "Load the automation-design Skill before creating an Automation.",
        "Create one Automation with time, event, idle, or chat-turn count triggers; several event triggers are allowed.",
        "Chain Automations only when the user asks: the later one gets an automation.run_ended trigger. A chain is one step deep (a run it started never starts another), and an Automation never wakes itself.",
        "Use it for future time, event, or cadence; do useful immediate work now and do not combine it with a Task in the chat or a Workflow merely for liveness.",
        "It lives and reports in one chat: chat=own (default) gives independent recurring work such as recurring reminders, briefs, digests and monitors a chat of its own; chat=current when the user asks for results in this chat, or for a reminder or check back on a request made in this conversation; chat_ref for another of the user's chats or a Space room. Tell the user where its reports will go.",
        "Choose history explicitly: fresh starts each run with no history; chat reads the chat's history. An Automation that reads one of the user's chats runs on that chat's model.",
        "In one of the user's chats, a run that reads it works in a hidden copy with that chat's model and action mode, and one that starts fresh works in the Automation's own chat with its own; only the report reaches the user's chat. Each run's final reply is its report.",
        'Write the alert rule into the prompt: "tell me when X" also reports a new obstacle to X that needs the user, "only tell me when X" reports nothing else, not even errors, and each run declares its verdict with report (news, or no_change when nothing qualifies).',
        "A watch for one result is temporary even without a deadline: write its end (a date or a number of checks) into the prompt and tell the run to stop with automation_followup once X is confirmed or the end passes; never extend it on your own. A stopped Automation, or a one-time one that ran, is removed on its own; do not clean it up.",
        "For retained Memory reports, create with enabled=false, choose or reuse a source directory, bind it with wiki_configure_reports, then enable with automation_update. Save wiki_publish_report instructions in the prompt."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(CreateParametersSchema, {
        parseOptions: { onExcessProperty: "error" }
      }),
      metadata: {
        display: [
          { fact: "card", value: "automation" },
          { fact: "result", value: "automation_created" },
          { fact: "refresh", value: "automations" }
        ],
        effect: "arden_db",
        display_name: "Create Automation",
        standing: "always",
        kind: "tool",
        action: "write",
        approval_preview: "Create this Automation.",
        source: "_automations",
        changes_state: true,
        target: "reported",
        concurrency_group: "automations",
        destructive: false,
        default_approval: "ask",
        requirement: "boundary",
        permissions: ["automation"],
        idempotent: false
      },
      approvalPrompt: createCard,
      approvalEdits: CREATE_APPROVAL_EDITS,
      execute: async (input, ctx, effects) => {
        const problem = createConflict(input)
        if (problem !== undefined) {
          throw new ToolExecutionError(problem, { preview: "Settings refused", retryable: false })
        }
        await assertAppEvents(input.triggers, services.apps, { creating: true })
        const {
          chat: requested,
          chat_ref,
          reads: _reads,
          will_not: _willNot,
          ...automationInput
        } = input
        const where = createChatWhere(requested, chat_ref)
        const chat = await chosenChat({ where, chat_ref }, services, ctx.run.sessionId, ctx.signal)
        const writer = promptWriterOf(ctx.approval)
        const automation = await recordApplied(
          effects,
          Effect.runPromise(
            services.store
              .create(
                {
                  ...createRequestOf(automationInput, chat),
                  idempotency_key: randomUUID(),
                  idempotency_scope: "global"
                },
                writer,
                { runId: ctx.run.runId, toolCallId: ctx.toolCallId }
              )
              .pipe(Effect.mapError(storeFailure)),
            { signal: ctx.signal }
          )
        )
        const automationRef = automation.automation_ref
        const modelInfo = await automationModelInfo(automation, services, ctx.signal)
        return {
          result: [
            `Created Automation: ${automation.name}`,
            `Reference: ${automationRef}`,
            "Triggers:",
            triggersLabel(automation, "  "),
            `Schedule: ${scheduleStatus(automation)}`,
            `Reports go to: ${chatLabel(automation, modelInfo, ctx.run.sessionId)}`,
            `History: ${historyLabel(automation)}`,
            `Model: ${modelLabel(modelInfo)}`,
            `Next run: ${nextRunAt(automation) ?? "not scheduled"}`,
            "It is saved; do not create it again."
          ].join("\n"),
          preview: `Created (${automationRef})`,
          data: automationData(automation, modelInfo)
        }
      }
    }),
    defineServerTool({
      name: "automation_list",
      summary: "Looks at your automations.",
      discovery: { group: "automations" },
      description:
        "List every user and built-in system Automation by stable ref, with no limit. Each entry has its full instructions, schedule, chat, history, effective model, action mode and current status. A system Automation also shows the settings it accepts and those changed from their default.",
      parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
      metadata: {
        effect: "none",
        display_name: "List Automations",
        kind: "tool",
        action: "read",
        approval_preview: "List Automations.",
        source: "_automations",
        changes_state: false,
        concurrency_group: null,
        destructive: null,
        permissions: ["automation"]
      },
      execute: async (_input, ctx) => {
        const all = await Effect.runPromise(
          services.store.list().pipe(Effect.mapError(storeFailure)),
          { signal: ctx.signal }
        )
        const automations = [...all].sort((left, right) =>
          left.automation_ref.localeCompare(right.automation_ref)
        )
        const entries = await Promise.all(
          automations.map(async (automation) => ({
            automation,
            modelInfo: await automationModelInfo(automation, services, ctx.signal)
          }))
        )
        return {
          result:
            entries.length === 0
              ? "No Automations."
              : entries
                  .map(({ automation, modelInfo }) =>
                    formatAutomation(automation, modelInfo, ctx.run.sessionId)
                  )
                  .join("\n\n"),
          preview: `${countOf(entries.length, "Automation")}`,
          data: {
            automations: entries.map(({ automation, modelInfo }) =>
              automationData(automation, modelInfo)
            )
          }
        }
      }
    }),
    defineServerTool({
      name: "automation_list_runs",
      summary: "Looks at an automation’s past runs.",
      discovery: { group: "automations" },
      description:
        "List recent runs for one Automation by exact automation_ref. A run skipped by its run_only_if sentence appears with its event; that is expected, not a failure.",
      parameters: Schema.toStandardSchemaV1(RunsParametersSchema),
      metadata: {
        effect: "none",
        display_name: "List Automation Runs",
        kind: "tool",
        action: "read",
        approval_preview: "List recent Automation runs.",
        source: "_automations",
        changes_state: false,
        concurrency_group: null,
        destructive: null,
        permissions: ["automation"]
      },
      execute: async (input, ctx) => {
        const automation = await resolveAutomation(services.store, input.automation_ref, ctx.signal)
        const loaded = await Effect.runPromise(
          services.store
            .runs(AutomationId.make(automation.task_id), input.limit)
            .pipe(Effect.mapError(storeFailure)),
          { signal: ctx.signal }
        )
        const runs = requireResult("run listing", loaded)
        const content =
          runs.length === 0
            ? `No runs for ${input.automation_ref}.`
            : runs.map(automationRunLines).join("\n")
        return {
          result: content,
          preview: `${countOf(runs.length, "Automation run")}`,
          data: { automation_ref: input.automation_ref, runs }
        }
      }
    }),
    makeAutomationUpdateTool(services),
    defineServerTool({
      name: "automation_delete",
      summary: "Removes an automation.",
      discovery: { group: "automations" },
      description:
        "End one Automation by exact automation_ref when its job is finished or the user no longer wants it: it is removed and its own chat, with its reports, is archived. To stop it only for now, pause it with automation_update enabled=false instead. Built-in system Automations cannot be deleted; pause them. Asks by default.",
      parameters: Schema.toStandardSchemaV1(RefParametersSchema),
      metadata: {
        display: [{ fact: "refresh", value: "automations" }],
        effect: "arden_db",
        display_name: "Delete Automation",
        standing: "always",
        kind: "tool",
        action: "write",
        approval_preview: "Delete this Automation and archive its chat.",
        source: "_automations",
        changes_state: true,
        target: "reported",
        concurrency_group: "automations",
        destructive: true,
        default_approval: "ask",
        permissions: ["automation"],
        idempotent: true
      },
      execute: async (input, ctx, effects) => {
        const automation = await resolveAutomation(services.store, input.automation_ref, ctx.signal)
        const lastVersion = await lastAutomationVersion(services.store, automation, ctx.signal)
        requireResult(
          "delete",
          await recordApplied(
            effects,
            Effect.runPromise(
              services.store
                .delete(AutomationId.make(automation.task_id))
                .pipe(Effect.mapError(storeFailure)),
              { signal: ctx.signal }
            )
          )
        )
        return {
          result: `Deleted Automation: ${automation.name} (${input.automation_ref})`,
          preview: "Deleted",
          data: { automation_ref: input.automation_ref, name: automation.name },
          host: appliedReceipt(
            ctx,
            deletedAutomationResource(
              { ...automation, automation_ref: input.automation_ref },
              lastVersion
            )
          )
        }
      }
    }),
    defineServerTool({
      name: "automation_run",
      summary: "Starts an automation right now.",
      discovery: { group: "automations" },
      description:
        "Queue one run of an Automation now. An enabled Automation starts as soon as a worker is free. A paused one is queued but waits until it is resumed; this does not resume it or its schedule. Refused while it is already running. Returns before the run ends; check automation_list_runs for the outcome. A system Automation that needs its trigger's input (Chat summaries) has no manual run. Uses the user's approval settings.",
      parameters: Schema.toStandardSchemaV1(RefParametersSchema),
      metadata: {
        display: [{ fact: "refresh", value: "automations" }],
        effect: "arden_db",
        detached: true,
        display_name: "Run Automation",
        kind: "tool",
        action: "execute",
        approval_preview: "Run this Automation now.",
        source: "_automations",
        changes_state: true,
        target: "reported",
        concurrency_group: "automations",
        destructive: true,
        default_approval: "ask",
        policy_scope: "internal",
        permissions: ["automation"],
        open_world: true,
        idempotent: false
      },
      execute: async (input, ctx, effects) => {
        const automation = await resolveAutomation(services.store, input.automation_ref, ctx.signal)
        if (automationGuards.system(automation) && !automation.manual_run) {
          throw new ToolExecutionError(
            `${automation.name} runs only when its trigger fires; it has no manual run`,
            { preview: "No manual run", retryable: false }
          )
        }
        if (isRunning(automation)) {
          throw new ToolExecutionError("The Automation is already running", {
            preview: "Already running",
            retryable: false
          })
        }
        const started = await Effect.runPromise(
          services
            .runNow(AutomationId.make(automation.task_id))
            .pipe(Effect.mapError(storeFailure)),
          { signal: ctx.signal }
        )
        if (started) effects.applied()
        if (!started) {
          throw new ToolExecutionError("The Automation disappeared before it could be queued", {
            preview: "Automation not found",
            retryable: false
          })
        }
        return {
          result: automation.enabled
            ? `Automation ${input.automation_ref} queued. Use automation_list_runs to inspect its outcome.`
            : `Automation ${input.automation_ref} is paused: the run waits and starts when it is resumed.`,
          preview: "Queued",
          data: { automation_ref: input.automation_ref, status: "queued" },
          host: appliedReceipt(
            ctx,
            automationResource(
              { ...automation, automation_ref: input.automation_ref },
              `${automation.name}: run queued`
            )
          )
        }
      }
    })
  ]
}

export const automationTools = Effect.gen(function* () {
  const store = yield* AutomationCatalog
  const queue = yield* AutomationQueue
  return makeAutomationTools({
    store,
    runNow: queue.requestRun,
    sessions: yield* SessionQueries,
    sessionStore: yield* SessionStore,
    models: yield* ModelStore,
    policy: yield* ApprovalPolicyStore,
    limits: yield* LimitSettingsStore,
    apps: (yield* McpConnections).snapshot
  })
})
