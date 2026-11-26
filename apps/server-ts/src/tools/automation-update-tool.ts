import { ToolExecutionError } from "@arden-hq/loop"
import { AUTOMATION_HISTORY, automationPermissionChat } from "@arden-hq/protocol/automations"
import { Effect, Schema } from "effect"
import { AUTOMATION_WRITE_TOOL } from "../persistence/automations/tool-names.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { assertAppEvents } from "./automation-app-events.js"
import { AutomationId } from "../persistence/automations/model.js"
import { setAutomationLimits } from "./automation-limits.js"
import { UpdateParametersSchema } from "./automation-tool-schema.js"
import { requireResult } from "./tool-failure.js"
import { promptWriterOf } from "./automation-create-card.js"
import {
  SYSTEM_ACCEPTS,
  chatLabel,
  droppedTriggerLines,
  modelLabel,
  historyLabel,
  scheduleStatus,
  systemLines,
  triggersLabel
} from "./automation-tool-text.js"
import { recordApplied } from "../execution/tool-effect.js"
import { updateCard } from "./automation-update-card.js"
import { updateRequestOf, updateTriggersOf } from "./automation-tool-requests.js"
import { automationData, historyOf, isRunning } from "./automation-tool-data.js"
import { resolveAutomation, storeFailure } from "./automation-records.js"
import {
  type AutomationToolServices,
  automationGuards,
  automationModelInfo,
  chatGuards,
  chosenChat,
  modelFailure,
  policyFailure
} from "./automation-tool-support.js"

export const makeAutomationUpdateTool = (services: AutomationToolServices): ServerTool =>
  defineServerTool({
    name: AUTOMATION_WRITE_TOOL.update,
    summary: "Changes an automation’s instructions or schedule.",
    discovery: { group: "automations" },
    description: [
      "Load the automation-design Skill before revising an Automation's instructions or schedule.",
      "Update one Automation by exact automation_ref.",
      "Use chat=current, chat=own or chat_ref to move future runs to another chat; history chooses whether each run starts fresh or reads that chat. Runs act with the action mode of their chat, or of their own chat when they start fresh in one of the user's. Four changes each go in a call of their own: action_mode, the plan limits (pause_at_percent and max_tokens_per_run together), reset_to_default, and a model change when the runs read one of the user's chats. Other changes edit instructions, model, triggers or schedule. Sending triggers replaces the list: send each trigger to keep with its id (t1, t2) from the Automation's text; a field you leave out keeps its stored value, such as an old field condition, and null clears it.",
      `${SYSTEM_ACCEPTS} Use reset_to_default to undo one of its changed settings.`,
      "To add an installed tool to a built-in Automation: look the tool up if unsure what it is, check its command exists, offer that command with permission_offer (permission.command) (its card has Arden's own jobs; a built-in runs only commands that list allows), then change its prompt here to use it, and tell the person reset_to_default prompt restores the shipped one."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(UpdateParametersSchema, {
      parseOptions: { onExcessProperty: "error" }
    }),
    metadata: {
      display: [{ fact: "refresh", value: "automations" }],
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
      if (automationGuards.system(current)) {
        const accepted: ReadonlyArray<string> = [
          ...current.settings.settable,
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
        if (automationGuards.user(current)) {
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
          preview: `Reset (${reset.automation_ref})`,
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
        return setAutomationLimits(services.limits, current, current.automation_ref, {
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
        chatGuards.yours(current.chat) &&
        chat === undefined &&
        (changes.history ?? historyOf(current)) === AUTOMATION_HISTORY.chat &&
        changes.model != null
      if (chatModelChange && chatGuards.yours(current.chat) && changes.model != null) {
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
                      updateRequestOf(changes, chat),
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
          : droppedTriggerLines(current, updateTriggersOf(changes.triggers), "  ")
      return {
        result: [
          `Updated Automation: ${updated.name}`,
          `Reference: ${updated.automation_ref}`,
          "Triggers:",
          triggersLabel(updated, "  "),
          ...(dropped.length === 0
            ? []
            : ["Dropped by this write (no trigger checks them now):", ...dropped]),
          `Schedule: ${scheduleStatus(updated)}`,
          ...(!updated.enabled && isRunning(updated) ? ["Current run: still running"] : []),
          ...(automationGuards.user(updated)
            ? [
                `Chat: ${chatLabel(updated, modelInfo, ctx.run.sessionId)}`,
                `History: ${historyLabel(updated)}`
              ]
            : []),
          `Model: ${modelLabel(modelInfo)}`,
          ...systemLines(updated)
        ].join("\n"),
        preview: `Updated (${updated.automation_ref})`,
        data: automationData(updated, modelInfo)
      }
    }
  })
