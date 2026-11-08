import { groupedCount } from "@arden-hq/std/count"
import {
  automationEnabledWord,
  mergeTriggerInputs,
  type Automation
} from "@arden-hq/protocol/automations"
import type { ApprovalPresentationField } from "@arden-hq/protocol/chat"
import type { UpdateParametersSchema } from "./automation-tool-schema.js"
import { createDestinationLabel } from "./automation-create-card.js"
import { triggerInputWords } from "./automation-tool-text.js"
import { APPROVAL_MODE_LABEL } from "./onboarding.js"

type Changes = (typeof UpdateParametersSchema.Type)["changes"]

const change = (label: string, from: string, to: string): ApprovalPresentationField =>
  from === to ? { label, value: to } : { label, value: to, from }

const modelWords = (model: string | null): string => model ?? "Background model"
const HISTORY_WORDS = { chat: "Reads the chat", fresh: "Starts fresh" } as const
const historyWords = (history: Automation["history"]): string =>
  history === null ? "Set by the system" : HISTORY_WORDS[history]
const cooldownWords = (minutes: number | null): string =>
  minutes === null ? "None" : `${minutes} min`

export const updateCard = (current: Automation, changes: Changes) => {
  const fields: Array<ApprovalPresentationField> = []
  if (changes.reset_to_default !== undefined) {
    fields.push({ label: "Reset", value: `${changes.reset_to_default} to its default` })
  }
  if (changes.enabled !== undefined) {
    fields.push(
      change(
        "Status",
        automationEnabledWord(current.enabled),
        automationEnabledWord(changes.enabled)
      )
    )
  }
  if (changes.name !== undefined) fields.push(change("Name", current.name, changes.name))
  if (changes.description !== undefined) {
    fields.push(change("About", current.description ?? "None", changes.description ?? "None"))
  }
  if (changes.triggers !== undefined) {
    const merged = mergeTriggerInputs({ triggers: current.triggers, lastId: 0 }, changes.triggers)
    fields.push(
      change(
        "When",
        triggerInputWords(current.triggers),
        triggerInputWords(merged.kind === "ok" ? merged.triggers : changes.triggers)
      )
    )
  }
  if (changes.chat !== undefined || changes.chat_ref !== undefined) {
    fields.push({
      label: "Reports to",
      value: createDestinationLabel(changes.chat, changes.chat_ref)
    })
  }
  if (changes.history !== undefined) {
    fields.push(change("History", historyWords(current.history), historyWords(changes.history)))
  }
  if (changes.model !== undefined) {
    fields.push(change("Model", modelWords(current.model), modelWords(changes.model)))
  }
  if (changes.action_mode !== undefined) {
    fields.push({ label: "Action mode", value: APPROVAL_MODE_LABEL[changes.action_mode] })
  }
  if (changes.cooldown_minutes !== undefined) {
    fields.push(
      change(
        "Cooldown",
        cooldownWords(current.cooldown_minutes),
        cooldownWords(changes.cooldown_minutes)
      )
    )
  }
  if (changes.pause_at_percent !== undefined) {
    fields.push({
      label: "Pause at",
      value: changes.pause_at_percent === null ? "No limit" : `${changes.pause_at_percent}% of plan`
    })
  }
  if (changes.max_tokens_per_run !== undefined) {
    fields.push({
      label: "Tokens per run",
      value:
        changes.max_tokens_per_run === null ? "No limit" : groupedCount(changes.max_tokens_per_run)
    })
  }
  return {
    title: "Change an automation?",
    subject: current.name,
    fields,
    ...(changes.prompt === undefined
      ? {}
      : {
          body: {
            label: "Instructions",
            text: changes.prompt,
            ...(current.prompt === changes.prompt ? {} : { before: current.prompt })
          }
        }),
    approve_label: "Save"
  }
}
