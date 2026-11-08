import { countOf } from "@arden-hq/std/count"
import type { ToolApprovalContext, ToolContext } from "@arden-hq/loop"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { DEFAULT_APPROVAL_MODE } from "@arden-hq/protocol/permissions"
import { Effect, Schema } from "effect"
import type { PromptWriter } from "../persistence/automations/catalog.js"
import type { ModelStore } from "../persistence/models/store.js"
import { personalAutomationTriggers } from "../automations/schedule.js"
import { InvalidAutomationScheduleError } from "../persistence/automations/model.js"
import { type ApprovalEditLine, type ServerApprovalEdits } from "./approval-edits.js"
import type { CreateParametersSchema } from "./automation-tool-schema.js"
import { triggerInputWords } from "./automation-tool-text.js"
import { APPROVAL_MODE_LABEL } from "./onboarding.js"
import { toolFailure } from "./tool-failure.js"
import type { ServerApprovalPrompt } from "./define.js"
import type { ServerRunContext } from "./run-context.js"
import { sameJson } from "@arden-hq/std/json"

export const createChatWhere = (
  where: "current" | "own" | undefined,
  chatRef: string | undefined
): "current" | "own" | undefined => where ?? (chatRef === undefined ? "own" : undefined)

export const createDestinationLabel = (
  where: "current" | "own" | undefined,
  chatRef: string | undefined
): string => {
  if (chatRef !== undefined) return chatRef
  return createChatWhere(where, chatRef) === "current" ? "This chat" : "Its own chat"
}

const CREATE_EDITABLE_FIELDS = [
  "name",
  "triggers",
  "chat",
  "chat_ref",
  "approval_mode",
  "model",
  "prompt"
] as const

type CreateInput = typeof CreateParametersSchema.Type

export const jsonArguments = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))

export const createConflict = (input: CreateInput): string | undefined => {
  const schedule = triggersProblem(input.triggers)
  if (schedule !== undefined) return schedule
  if (input.chat === "own" && input.chat_ref !== undefined) {
    return "Choose chat=own or a chat_ref, not both"
  }
  if (input.approval_mode !== undefined && createChatWhere(input.chat, input.chat_ref) !== "own") {
    return "An Automation in one of the user's chats uses that chat's action mode: omit approval_mode, or give it a chat of its own (omit chat)"
  }
  return undefined
}

const triggersProblem = (triggers: CreateInput["triggers"]): string | undefined => {
  try {
    personalAutomationTriggers(triggers)
    return undefined
  } catch (error) {
    if (error instanceof InvalidAutomationScheduleError) return error.message
    throw error
  }
}

const createActionModeLabel = (input: CreateInput, chatMode: ChatApprovalMode): string => {
  if (createChatWhere(input.chat, input.chat_ref) === "own") {
    return APPROVAL_MODE_LABEL[input.approval_mode ?? DEFAULT_APPROVAL_MODE]
  }
  return input.chat_ref === undefined
    ? `${APPROVAL_MODE_LABEL[chatMode]}, same as this chat`
    : "Same as that chat"
}

const createModelLabel = async (
  input: CreateInput,
  models: ModelStore["Service"],
  signal: AbortSignal
): Promise<string> => {
  if (input.model !== undefined && input.model !== null) return input.model
  if (input.history === "chat" && createChatWhere(input.chat, input.chat_ref) !== "own") {
    return "The chat's own model"
  }
  const settings = await Effect.runPromise(
    models.snapshot().pipe(Effect.mapError((error) => toolFailure(error, "Model unavailable"))),
    {
      signal
    }
  )
  return `${settings.roleOverrides.background.modelId}, Background`
}

const modeWords = (input: CreateInput): string =>
  createChatWhere(input.chat, input.chat_ref) === "own"
    ? APPROVAL_MODE_LABEL[input.approval_mode ?? DEFAULT_APPROVAL_MODE]
    : "the chat's own"

const describeCreateEdits = (
  requested: CreateInput,
  edited: CreateInput
): ReadonlyArray<ApprovalEditLine> => {
  const differs = (field: keyof CreateInput) => !sameJson(requested[field], edited[field])
  const where = (input: CreateInput) => createDestinationLabel(input.chat, input.chat_ref)
  const lines: ReadonlyArray<ApprovalEditLine | undefined> = [
    differs("name")
      ? { field: "name", label: "Name", from: `"${requested.name}"`, to: `"${edited.name}"` }
      : undefined,
    differs("triggers")
      ? {
          field: "triggers",
          label: "When",
          from: triggerInputWords(requested.triggers),
          to: triggerInputWords(edited.triggers)
        }
      : undefined,
    differs("chat") || differs("chat_ref")
      ? { field: "chat", label: "Reports to", from: where(requested), to: where(edited) }
      : undefined,
    modeWords(requested) === modeWords(edited)
      ? undefined
      : {
          field: "approval_mode",
          label: "Action mode",
          from: modeWords(requested),
          to: modeWords(edited)
        },
    differs("model")
      ? {
          field: "model",
          label: "Model",
          from: requested.model ?? "the Background model",
          to: edited.model ?? "the Background model"
        }
      : undefined,
    differs("prompt")
      ? {
          field: "prompt",
          label: "Instructions",
          from: `your ${countOf(requested.prompt.length, "character")}`,
          to: `the user's ${countOf(edited.prompt.length, "character")}, saved as written (read them with automation_list)`
        }
      : undefined
  ]
  return lines.filter((line) => line !== undefined)
}

export const CREATE_APPROVAL_EDITS: ServerApprovalEdits<CreateInput> = {
  fields: CREATE_EDITABLE_FIELDS,
  check: createConflict,
  describe: describeCreateEdits
}

export const promptWriterOf = (approval: ToolApprovalContext | undefined): PromptWriter =>
  approval === undefined || approval.reviewer === true ? "agent" : "owner"

interface CreateCardServices {
  readonly models: ModelStore["Service"]
}

export const createCardOf =
  (services: CreateCardServices) =>
  async (input: CreateInput, ctx: ToolContext<ServerRunContext>): Promise<ServerApprovalPrompt> => {
    return {
      preview: "Create this Automation.",
      presentation: {
        title: "Create an automation?",
        subject: input.name,
        fields: [
          ...(input.description === undefined
            ? []
            : [{ label: "About", value: input.description }]),
          { label: "When", value: triggerInputWords(input.triggers) },
          { label: "Reports to", value: createDestinationLabel(input.chat, input.chat_ref) },
          { label: "History", value: input.history === "chat" ? "Reads the chat" : "Starts fresh" },
          ...(input.reads === undefined ? [] : [{ label: "Reads", value: input.reads }]),
          ...(input.will_not === undefined ? [] : [{ label: "Won’t", value: input.will_not }]),
          { label: "Action mode", value: createActionModeLabel(input, ctx.run.approvalMode) },
          { label: "Model", value: await createModelLabel(input, services.models, ctx.signal) }
        ],
        body: { label: "Instructions", text: input.prompt },
        approve_label: "Create",
        editable: { fields: CREATE_EDITABLE_FIELDS, arguments: jsonArguments(input) }
      }
    }
  }
