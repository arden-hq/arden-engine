import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ChatMessage, JsonObject, ModelRequest } from "@arden-hq/loop"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { ChatRunnerInput } from "./runner-contract.js"
import { currentIso } from "../runtime/clock.js"

export const DEVELOPER_CONTEXT_SOURCE = {
  localInstructions: "local_instructions",
  localTime: "local_time",
  stepLimit: "step_limit"
} as const
type DeveloperContextSource =
  (typeof DEVELOPER_CONTEXT_SOURCE)[keyof typeof DEVELOPER_CONTEXT_SOURCE]

const DEVELOPER_CONTEXT_LABEL: Readonly<Record<DeveloperContextSource, string>> = {
  local_instructions: "local instructions",
  local_time: "local time",
  step_limit: "step limit"
}

const renderDeveloperContext = ({
  source,
  content
}: {
  readonly source: DeveloperContextSource
  readonly content: string
}): string => {
  const label = DEVELOPER_CONTEXT_LABEL[source]
  return [
    `Current Arden ${label}; this replaces earlier Arden ${label} updates.`,
    content.trim().length === 0 ? "(none)" : content
  ].join("\n\n")
}

export const appendDeveloperContext = ({
  request,
  input,
  source,
  content,
  metadata = {}
}: {
  readonly request: ModelRequest
  readonly input: Pick<ChatRunnerInput, "runId" | "turnId">
  readonly source: DeveloperContextSource
  readonly content: string
  readonly metadata?: JsonObject
}): ModelRequest => {
  const previous = request.messages.reduce<ChatMessage | undefined>(
    (last, message) =>
      message.role === ROLE.developer && message.arden_context_source === source ? message : last,
    undefined
  )
  if (previous === undefined && content.trim().length === 0) return request
  const rendered = renderDeveloperContext({ source, content })
  if (
    previous?.content === rendered &&
    Object.entries(metadata).every(([key, value]) => isDeepStrictEqual(previous[key], value))
  )
    return request
  const messages: ReadonlyArray<ChatMessage> = [
    ...request.messages,
    {
      role: ROLE.developer,
      message_id: `${input.runId}:context:${source}:${randomUUID()}`,
      created_at: currentIso(),
      turn_id: input.turnId,
      ...metadata,
      arden_context_source: source,
      content: rendered
    }
  ]
  return { ...request, messages, compactionReplacement: messages }
}
