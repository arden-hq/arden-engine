import { clipLine, cutText } from "@arden-hq/std/text"
import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import {
  AUTOMATION_EVENTS,
  automationPermissionChat,
  type Automation,
  type AutomationChatChoice,
  type AutomationRun
} from "@arden-hq/protocol/automations"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { assertAppEvents } from "./automation-app-events.js"
import { McpConnections } from "../mcp/service.js"
import type { AutomationRuntime } from "../automations/runtime.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { AutomationId } from "../persistence/automations/model.js"
import { AutomationQueue } from "../persistence/automations/queue.js"
import { SessionQueries, type SessionQueryFailure } from "../persistence/sessions/queries.js"
import { SessionStore, type SessionStoreError } from "../persistence/sessions/store.js"
import { ModelStore, type ModelStoreError } from "../persistence/models/store.js"
import { LimitSettingsStore } from "../persistence/settings/store.js"
import { setAutomationLimits } from "./automation-limits.js"
import {
  ApprovalPolicyStore,
  type ApprovalPolicyError
} from "../persistence/permissions/approval-policy.js"
import {
  CreateParametersSchema,
  EmptyParametersSchema,
  RefParametersSchema,
  RunsParametersSchema,
  UpdateParametersSchema
} from "./automation-tool-schema.js"
import { toolFailure } from "./tool-failure.js"
import {
  CREATE_APPROVAL_EDITS,
  createCardOf,
  createChatWhere,
  createConflict,
  promptWriterOf
} from "./automation-create-card.js"
import {
  SYSTEM_ACCEPTS,
  chatLabel,
  formatAutomation,
  droppedTriggerLines,
  modelLabel,
  historyLabel,
  requireAutomationRef,
  scheduleStatus,
  skippedEventCall,
  systemLines,
  triggersLabel,
  type AutomationModelInfo
} from "./automation-tool-text.js"
import { recordApplied } from "../execution/tool-effect.js"
import { updateCard } from "./automation-update-card.js"
import { appliedReceipt } from "./call-receipt.js"
import {
  automationResource,
  deletedAutomationResource,
  lastAutomationVersion,
  resolveAutomation,
  storeFailure
} from "./automation-records.js"

interface AutomationToolServices {
  readonly store: AutomationCatalog["Service"]
  readonly runNow: AutomationRuntime["Service"]["runNow"]
  readonly sessions: SessionQueries["Service"]
  readonly sessionStore: SessionStore["Service"]
  readonly models: ModelStore["Service"]
  readonly policy: ApprovalPolicyStore["Service"]
  readonly limits: LimitSettingsStore["Service"]
  readonly apps: McpConnections["Service"]["snapshot"]
}

const sessionFailure = (error: SessionQueryFailure): ToolExecutionError =>
  toolFailure(
    { reason: error.reason, message: `Could not read the Automation's chat: ${error.message}` },
    "Chat unavailable"
  )

const sessionStoreFailure = (error: SessionStoreError): ToolExecutionError =>
  toolFailure(error, "Chat unavailable")

const modelFailure = (error: ModelStoreError): ToolExecutionError =>
  toolFailure(error, "Model unavailable")

const policyFailure = (error: ApprovalPolicyError): ToolExecutionError =>
  toolFailure(error, "Chat permissions unavailable")

const resolveChatRef = async (
  store: SessionStore["Service"],
  sessionRef: string,
  signal: AbortSignal
) => {
  const [session] = await Effect.runPromise(
    store.list({ sessionRef, scope: "all", limit: 1 }).pipe(Effect.mapError(sessionStoreFailure)),
    { signal }
  )
  if (session !== undefined) return session
  throw new ToolExecutionError(`No active Chat ${sessionRef}`, {
    preview: "Chat not found",
    retryable: false
  })
}

const automationModelInfo = async (
  automation: Automation,
  services: AutomationToolServices,
  signal: AbortSignal
): Promise<AutomationModelInfo> => {
  const chat = automation.chat
  const runChat =
    chat === null
      ? null
      : await Effect.runPromise(
          services.sessions
            .loadHistoryHeader(chat.session_id)
            .pipe(Effect.mapError(sessionFailure)),
          { signal }
        )
  const permissionChat = automationPermissionChat(automation)
  const permission =
    permissionChat === null
      ? null
      : await Effect.runPromise(
          services.policy.session(permissionChat).pipe(Effect.mapError(policyFailure)),
          { signal }
        )
  const context = {
    chat_ref: chat?.kind === "yours" ? (runChat?.publicRef ?? null) : null,
    action_mode: permission?.approval_mode ?? null
  }
  if (automation.system !== null && !automation.system.settable.includes("model")) {
    return { ...context, model_source: "source_chat", effective_model: null }
  }
  if (automation.model !== null) {
    return { ...context, model_source: "override", effective_model: automation.model }
  }
  if (chat?.kind === "yours" && automation.history === "chat") {
    if (runChat === null) return { ...context, model_source: "unknown", effective_model: null }
    const selection = await Effect.runPromise(
      services.models.selection(runChat.sessionId).pipe(Effect.mapError(modelFailure)),
      { signal }
    )
    return { ...context, model_source: "chat", effective_model: selection.modelId }
  }
  const settings = await Effect.runPromise(
    services.models.snapshot().pipe(Effect.mapError(modelFailure)),
    { signal }
  )
  return {
    ...context,
    model_source: "background",
    effective_model: settings.roleOverrides.background.modelId
  }
}

const automationData = (automation: Automation, modelInfo: AutomationModelInfo) => ({
  automation_ref: requireAutomationRef(automation),
  name: automation.name,
  description: automation.description,
  prompt: automation.prompt,
  model: automation.model,
  chat: automation.chat === null ? null : automation.chat.kind,
  history: automation.history,
  ...modelInfo,
  handler: automation.handler,
  triggers: automation.triggers,
  enabled: automation.enabled,
  created_at: automation.created_at,
  last_run_at: automation.last_run_at,
  next_run_at: automation.next_run_at,
  recent_statuses: automation.recent_statuses,
  last_result: automation.last_result,
  running_since: automation.running_since,
  waiting_on: automation.waiting_on,
  waiting_events: automation.waiting_events,
  builtin: automation.builtin,
  cooldown_minutes: automation.cooldown_minutes,
  old_conditions: automation.old_conditions,
  manual_run: automation.manual_run,
  system: automation.system
})

const runData = (run: AutomationRun) => ({
  id: run.id,
  chat_run_id: run.chat_run_id,
  chat_session_id: run.chat_session_id,
  context_mode: run.context_mode,
  started_at: run.started_at,
  ended_at: run.ended_at,
  status: run.status,
  result: run.result,
  error: run.error,
  skipped: run.skipped
})

const runLines = (run: ReturnType<typeof runData>): string => {
  const summary = (run.error ?? run.result)?.replace(/\s+/gu, " ").trim()
  const head = [
    `- ${run.started_at}: ${run.status}, ${run.context_mode} context`,
    run.chat_run_id === null ? "" : `, run_id ${run.chat_run_id}`,
    summary === undefined || summary === "" ? "" : `. ${cutText(summary, 300)}`
  ].join("")
  if (run.skipped === null) return head
  const { event } = run.skipped
  const open = skippedEventCall(event.link)
  return [
    head,
    `  Held back: ${AUTOMATION_EVENTS[event.event_type].name} ${JSON.stringify(clipLine(event.title, 200))} (untrusted data)${run.skipped.ran === null ? "" : ", since run by the user"}.`,
    ...(open === undefined ? [] : [`  Open it with ${open}.`])
  ].join("\n")
}

const requireResult = <A>(operation: string, value: A | null): A => {
  if (value !== null) return value
  throw new ToolExecutionError(`The Automation disappeared during ${operation}`, {
    preview: "Automation not found",
    retryable: false
  })
}

const chosenChat = async (
  choice: { readonly where: "current" | "own" | undefined; readonly chat_ref: string | undefined },
  services: AutomationToolServices,
  currentSessionId: string,
  signal: AbortSignal
): Promise<AutomationChatChoice> => {
  if (choice.chat_ref === undefined) {
    return choice.where === "own"
      ? { kind: "own" }
      : { kind: "yours", session_id: currentSessionId }
  }
  if (choice.where === "own") {
    throw new ToolExecutionError("Choose chat=own or a chat_ref, not both", {
      preview: "Conflicting chat",
      retryable: false
    })
  }
  const target = await resolveChatRef(services.sessionStore, choice.chat_ref, signal)
  return { kind: "yours", session_id: target.sessionId }
}

const makeAutomationTools = (services: AutomationToolServices): ReadonlyArray<ServerTool> => {
  const createCard = createCardOf({ models: services.models })
  return [
    defineServerTool({
      name: "automation_create",
      description: [
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
        display: { card: "automation", result: "automation_created", refresh: "automations" },
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
                  ...automationInput,
                  chat,
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
        const automationRef = requireAutomationRef(automation)
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
            `Next run: ${automation.next_run_at ?? "not scheduled"}`,
            "It is saved; do not create it again."
          ].join("\n"),
          preview: `Created (${automationRef})`,
          data: automationData(automation, modelInfo)
        }
      }
    }),
    defineServerTool({
      name: "automation_list",
      description:
        "List the user's and the built-in system Automations by stable ref. Include instructions, schedule, chat, history, effective model, action mode, and current status; for a system Automation, the settings it accepts and those changed from their default.",
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
          requireAutomationRef(left).localeCompare(requireAutomationRef(right))
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
        const entries = runs.map(runData)
        const content =
          entries.length === 0
            ? `No runs for ${input.automation_ref}.`
            : entries.map(runLines).join("\n")
        return {
          result: content,
          preview: `${countOf(entries.length, "Automation run")}`,
          data: { automation_ref: input.automation_ref, runs: entries }
        }
      }
    }),
    defineServerTool({
      name: "automation_update",
      description: [
        "Update one Automation by exact automation_ref.",
        "Use chat=current, chat=own or chat_ref to move future runs to another chat; history chooses whether each run starts fresh or reads that chat. Runs act with the action mode of their chat, or of their own chat when they start fresh in one of the user's; change action_mode in a separate call. Other changes edit instructions, model, triggers or schedule. Sending triggers replaces the list: send each trigger to keep with its id (t1, t2) from the Automation's text; a field you leave out keeps its stored value, such as an old field condition, and null clears it.",
        `${SYSTEM_ACCEPTS} Use reset_to_default to undo one of its changed settings.`,
        "To add an installed tool to a built-in Automation: look the tool up if unsure what it is, check its command exists, offer that command with permission.command (its card has Arden's own jobs; a built-in runs only commands that list allows), then change its prompt here to use it, and tell the person reset_to_default prompt restores the shipped one."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(UpdateParametersSchema, {
        parseOptions: { onExcessProperty: "error" }
      }),
      metadata: {
        display: { refresh: "automations" },
        effect: "arden_db",
        display_name: "Update Automation",
        standing: "always",
        kind: "tool",
        action: "write",
        approval_preview: "Update this Automation.",
        source: "_automations",
        changes_state: true,
        target: "reported",
        concurrency_group: "automations",
        destructive: true,
        default_approval: "ask",
        permissions: ["automation"],
        idempotent: false
      },
      approvalPrompt: async (input, ctx) => {
        const current = await resolveAutomation(services.store, input.automation_ref, ctx.signal)
        return {
          preview: `Update ${current.name}.`,
          presentation: updateCard(current, input.changes)
        }
      },
      execute: async (input, ctx, effects) => {
        const current = await resolveAutomation(services.store, input.automation_ref, ctx.signal)
        const {
          chat: where,
          chat_ref,
          action_mode,
          pause_at_percent,
          max_tokens_per_run,
          reset_to_default,
          ...changes
        } = input.changes
        await assertAppEvents(changes.triggers, services.apps, { creating: false })
        if (current.system !== null) {
          const accepted: ReadonlyArray<string> = [
            ...current.system.settable,
            "pause_at_percent",
            "max_tokens_per_run",
            "reset_to_default"
          ]
          const locked = Object.keys(input.changes).filter((field) => !accepted.includes(field))
          if (locked.length > 0) {
            throw new ToolExecutionError(
              `${current.name} is a system Automation and cannot change ${locked.join(", ")}. It accepts only ${accepted.join(", ")}.`,
              { preview: "Fixed by the system", retryable: false }
            )
          }
        }
        if (reset_to_default !== undefined) {
          if (Object.keys(input.changes).length > 1) {
            throw new ToolExecutionError("Reset a setting in a separate automation_update call", {
              preview: "Separate reset",
              retryable: false
            })
          }
          if (current.system === null) {
            throw new ToolExecutionError("Only a system Automation has defaults to reset", {
              preview: "No default",
              retryable: false
            })
          }
          const reset = requireResult(
            "reset",
            await recordApplied(
              effects,
              Effect.runPromise(
                services.store
                  .resetSystemSetting(AutomationId.make(current.task_id), reset_to_default)
                  .pipe(Effect.mapError(storeFailure)),
                { signal: ctx.signal }
              )
            )
          )
          const modelInfo = await automationModelInfo(reset, services, ctx.signal)
          return {
            result: [
              `Reset ${reset_to_default} of ${reset.name} to its default`,
              "Triggers:",
              triggersLabel(reset, "  "),
              `Schedule: ${scheduleStatus(reset)}`,
              `Model: ${modelLabel(modelInfo)}`,
              ...systemLines(reset)
            ].join("\n"),
            preview: `Reset (${requireAutomationRef(reset)})`,
            data: automationData(reset, modelInfo)
          }
        }
        const alone = (fields: ReadonlyArray<string>): boolean =>
          Object.keys(input.changes).every((field) => fields.includes(field))
        if (pause_at_percent !== undefined || max_tokens_per_run !== undefined) {
          if (!alone(["pause_at_percent", "max_tokens_per_run"])) {
            throw new ToolExecutionError(
              "Change this Automation's plan limits in a separate automation_update call",
              { preview: "Separate limit change", retryable: false }
            )
          }
          return setAutomationLimits(services.limits, current, requireAutomationRef(current), {
            pause_at_percent,
            max_tokens_per_run,
            signal: ctx.signal
          })
        }
        if (action_mode !== undefined) {
          if (!alone(["action_mode"])) {
            throw new ToolExecutionError(
              "Change the chat's permissions in a separate automation_update call",
              { preview: "Separate permission change", retryable: false }
            )
          }
          const permissionChat = automationPermissionChat(current)
          if (permissionChat === null) {
            throw new ToolExecutionError("This Automation has no chat", {
              preview: "No chat",
              retryable: false
            })
          }
          await recordApplied(
            effects,
            Effect.runPromise(
              services.policy
                .setSession({
                  sessionId: permissionChat,
                  mode: action_mode
                })
                .pipe(Effect.mapError(policyFailure)),
              { signal: ctx.signal }
            )
          )
        }
        const chat =
          where === undefined && chat_ref === undefined
            ? undefined
            : await chosenChat({ where, chat_ref }, services, ctx.run.sessionId, ctx.signal)
        const chatModelChange =
          current.chat?.kind === "yours" &&
          chat === undefined &&
          (changes.history ?? current.history) === "chat" &&
          changes.model != null
        if (chatModelChange && current.chat !== null && changes.model != null) {
          if (!alone(["model"])) {
            throw new ToolExecutionError(
              "Change the chat's model in a separate automation_update call",
              { preview: "Separate model change", retryable: false }
            )
          }
          await recordApplied(
            effects,
            Effect.runPromise(
              services.models
                .setSessionModel(current.chat.session_id, changes.model)
                .pipe(Effect.mapError(modelFailure)),
              { signal: ctx.signal }
            )
          )
        }
        const updated =
          chatModelChange || action_mode !== undefined
            ? current
            : requireResult(
                "update",
                await recordApplied(
                  effects,
                  Effect.runPromise(
                    services.store
                      .update(
                        AutomationId.make(current.task_id),
                        {
                          ...changes,
                          ...(chat === undefined ? {} : { chat })
                        },
                        promptWriterOf(ctx.approval),
                        { runId: ctx.run.runId, toolCallId: ctx.toolCallId }
                      )
                      .pipe(Effect.mapError(storeFailure)),
                    { signal: ctx.signal }
                  )
                )
              )
        const modelInfo = await automationModelInfo(updated, services, ctx.signal)
        const dropped =
          changes.triggers === undefined || updated === current
            ? []
            : droppedTriggerLines(current, changes.triggers, "  ")
        return {
          result: [
            `Updated Automation: ${updated.name}`,
            `Reference: ${requireAutomationRef(updated)}`,
            "Triggers:",
            triggersLabel(updated, "  "),
            ...(dropped.length === 0
              ? []
              : ["Dropped by this write (no trigger checks them now):", ...dropped]),
            `Schedule: ${scheduleStatus(updated)}`,
            ...(!updated.enabled && updated.running_since !== null
              ? ["Current run: still running"]
              : []),
            ...(updated.system === null
              ? [
                  `Chat: ${chatLabel(updated, modelInfo, ctx.run.sessionId)}`,
                  `History: ${historyLabel(updated)}`
                ]
              : []),
            `Model: ${modelLabel(modelInfo)}`,
            ...systemLines(updated)
          ].join("\n"),
          preview: `Updated (${requireAutomationRef(updated)})`,
          data: automationData(updated, modelInfo)
        }
      }
    }),
    defineServerTool({
      name: "automation_delete",
      description:
        "End one Automation by exact automation_ref when its job is finished or the user no longer wants it: it is removed and its own chat, with its reports, is archived. To stop it only for now, pause it with automation_update enabled=false instead. Built-in system Automations cannot be deleted; pause them. Asks by default.",
      parameters: Schema.toStandardSchemaV1(RefParametersSchema),
      metadata: {
        display: { refresh: "automations" },
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
      description:
        "Queue one immediate run of an Automation, including a paused one, without enabling its schedule. Returns before completion; inspect automation_list_runs for the outcome. A system Automation that needs its trigger's input (Chat summaries) has no manual run. Uses the user's approval settings.",
      parameters: Schema.toStandardSchemaV1(RefParametersSchema),
      metadata: {
        display: { refresh: "automations" },
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
        if (!automation.manual_run) {
          throw new ToolExecutionError(
            `${automation.name} runs only when its trigger fires; it has no manual run`,
            { preview: "No manual run", retryable: false }
          )
        }
        if (automation.running_since !== null) {
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
