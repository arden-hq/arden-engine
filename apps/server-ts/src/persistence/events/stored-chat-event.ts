import type { ChatProjectionEvent } from "@arden-hq/protocol"
import {
  APPROVAL_ASKED,
  APPROVAL_ASKER,
  APPROVAL_CARD,
  APPROVAL_DIFF,
  APPROVAL_GRANT_FOLDER,
  APPROVAL_PREVIEW,
  AUTOMATION_PROMPT,
  CONNECTION_ACCOUNT,
  CONTENT_START,
  CONTEXT_SIZE,
  MESSAGE_CLOSURE,
  RUN_ACTIVITY_TARGET,
  RUN_CAUSE,
  RUN_USAGE,
  SESSION_NAME,
  TODO_EXPLANATION
} from "@arden-hq/protocol/chat"
import { PROVIDER_COST } from "@arden-hq/protocol"
import {
  ApprovalPresentationSchema,
  ChatProjectionEventSchema
} from "@arden-hq/protocol/effect/chat"
import { storedApprovalPresentation } from "../tools/approval-draft.js"
import { type Effect, Option, Schema } from "effect"
import { isJsonObject, JsonObjectSchema, type JsonObject } from "../json.js"
import { storedToolEventUpgrades } from "./stored-tool-event.js"
import {
  StoredAgentResultSchema,
  StoredInteractionSenderSchema,
  wireAgentResult,
  wireSender
} from "../transcript/interaction.js"

type StoredEventUpgrade = (event: JsonObject, sessionId: string) => JsonObject

const withoutKeys = (event: JsonObject, keys: ReadonlyArray<string>): JsonObject =>
  Object.fromEntries(Object.entries(event).filter(([key]) => !keys.includes(key)))

const textOr = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback

const withRoute = (event: JsonObject, sessionId: string): JsonObject =>
  isJsonObject(event["decision_route"])
    ? event
    : {
        ...event,
        decision_route: {
          source_kind: "run",
          source_session_id: textOr(event["session_id"], sessionId),
          basis: "source_v1"
        }
      }

const connectionNeeded: StoredEventUpgrade = (event, sessionId) => {
  if ("account" in event) return withRoute(event, sessionId)
  const ref = event["account_ref"]
  return withRoute(
    {
      ...withoutKeys(event, ["account_ref"]),
      session_id: textOr(event["session_id"], sessionId),
      account:
        typeof ref === "string"
          ? { kind: CONNECTION_ACCOUNT.account, ref }
          : { kind: CONNECTION_ACCOUNT.default }
    },
    sessionId
  )
}

const asJson = Schema.decodeUnknownSync(JsonObjectSchema)

const isWirePresentation = Schema.is(ApprovalPresentationSchema)

const withWireCard = (event: JsonObject): JsonObject => {
  const card = event["card"]
  if (!isJsonObject(card) || card["kind"] !== APPROVAL_CARD.presented) return event
  if (isWirePresentation(card["presentation"])) return event
  const presentation = storedApprovalPresentation(card["presentation"])
  return {
    ...event,
    card:
      presentation === undefined
        ? { kind: APPROVAL_CARD.plain }
        : { kind: APPROVAL_CARD.presented, presentation: asJson(presentation) }
  }
}

const approvalNeeded: StoredEventUpgrade = (event, sessionId) =>
  withWireCard("asked" in event ? event : legacyApprovalNeeded(event, sessionId))

const legacyApprovalNeeded: StoredEventUpgrade = (event, sessionId) => {
  const asked = event["asked_at"]
  const preview = event["content_preview"]
  const diff = event["diff"]
  const folder = event["grant_folder"]
  const presentation = event["presentation"]
  const work = event["work"]
  const places = event["rule_places"]
  return withRoute(
    {
      ...withoutKeys(event, [
        "asked_at",
        "content_preview",
        "path",
        "scope",
        "expires_at",
        "presentation",
        "work"
      ]),
      session_id: textOr(event["session_id"], sessionId),
      action: textOr(event["action"], ""),
      asked:
        typeof asked === "string"
          ? { kind: APPROVAL_ASKED.recorded, at: asked }
          : { kind: APPROVAL_ASKED.unrecorded },
      preview:
        typeof preview === "string"
          ? { kind: APPROVAL_PREVIEW.preview, text: preview }
          : { kind: APPROVAL_PREVIEW.none },
      diff:
        typeof diff === "string"
          ? { kind: APPROVAL_DIFF.diff, patch: diff }
          : { kind: APPROVAL_DIFF.none },
      rule_places: Array.isArray(places) ? places : [],
      can_attach_folder_to_space: event["can_attach_folder_to_space"] === true,
      grant_folder:
        typeof folder === "string"
          ? { kind: APPROVAL_GRANT_FOLDER.folder, folder }
          : { kind: APPROVAL_GRANT_FOLDER.none },
      card: isJsonObject(presentation)
        ? { kind: APPROVAL_CARD.presented, presentation }
        : { kind: APPROVAL_CARD.plain },
      asker: isJsonObject(work)
        ? { kind: APPROVAL_ASKER.work, work }
        : { kind: APPROVAL_ASKER.chat }
    },
    sessionId
  )
}

const messageEnd: StoredEventUpgrade = (event) => {
  if ("closure" in event) return event
  const content = event["content"]
  const start = event["content_start_seq"]
  return {
    ...withoutKeys(event, ["content", "content_start_seq"]),
    closure:
      typeof content === "string"
        ? { kind: MESSAGE_CLOSURE.complete, content }
        : { kind: MESSAGE_CLOSURE.abandoned },
    content_start:
      typeof start === "number"
        ? { kind: CONTENT_START.anchored, seq: start }
        : { kind: CONTENT_START.unanchored }
  }
}

const todoUpdated: StoredEventUpgrade = (event) => {
  const explanation = event["explanation"]
  if (isJsonObject(explanation)) return event
  const toolCallId = event["tool_call_id"]
  return {
    ...event,
    tool_call_id: typeof toolCallId === "string" ? toolCallId : (event["run_id"] ?? null),
    explanation:
      typeof explanation === "string"
        ? { kind: TODO_EXPLANATION.given, text: explanation }
        : { kind: TODO_EXPLANATION.none }
  }
}

const storedCause = (cause: JsonObject): JsonObject => {
  if (cause["kind"] === RUN_CAUSE.agentResult) {
    const result = Schema.decodeUnknownOption(StoredAgentResultSchema)(cause["agent_result"])
    return Option.isSome(result)
      ? { ...cause, agent_result: asJson(wireAgentResult(result.value)) }
      : cause
  }
  if (cause["kind"] !== RUN_CAUSE.interaction) return cause
  const interaction = cause["interaction"]
  const sender = Schema.decodeUnknownOption(StoredInteractionSenderSchema)(interaction)
  if (Option.isNone(sender) || !isJsonObject(interaction)) return cause
  return {
    ...cause,
    interaction: asJson({ ...wireSender(sender.value), content: interaction["content"] ?? "" })
  }
}

const legacyRunStarted: StoredEventUpgrade = (event) => {
  const question = event["question_answer"]
  const result = event["agent_result"]
  const interaction = event["interaction"]
  const update = event["update"]
  const task = event["automation_task_id"]
  const name = event["automation_name"]
  const prompt = event["automation_prompt"]
  return {
    ...withoutKeys(event, [
      "question_answer",
      "agent_result",
      "interaction",
      "update",
      "is_meta_run",
      "meta_client_id",
      "integrations",
      "integration_errors",
      "session_name",
      "automation_task_id",
      "automation_name",
      "automation_prompt",
      "automation_context_mode"
    ]),
    causes: [
      ...(isJsonObject(question)
        ? [{ kind: RUN_CAUSE.questionAnswer, question_id: question["question_id"] ?? null }]
        : []),
      ...(isJsonObject(result) ? [{ kind: RUN_CAUSE.agentResult, agent_result: result }] : []),
      ...(isJsonObject(interaction) ? [{ kind: RUN_CAUSE.interaction, interaction }] : []),
      ...(isJsonObject(update) ? [{ kind: RUN_CAUSE.update, update }] : []),
      ...(typeof task === "string" && typeof name === "string"
        ? [
            {
              kind: RUN_CAUSE.automation,
              task_id: task,
              name,
              prompt:
                typeof prompt === "string"
                  ? { kind: AUTOMATION_PROMPT.own, text: prompt }
                  : { kind: AUTOMATION_PROMPT.delegated },
              context_mode: textOr(event["automation_context_mode"], "continue")
            }
          ]
        : [])
    ]
  }
}

const runStarted: StoredEventUpgrade = (event, sessionId) => {
  const upgraded = Array.isArray(event["causes"]) ? event : legacyRunStarted(event, sessionId)
  const causes = upgraded["causes"]
  return Array.isArray(causes)
    ? {
        ...upgraded,
        causes: causes.map((cause) => (isJsonObject(cause) ? storedCause(cause) : cause))
      }
    : upgraded
}

const sessionUpdated: StoredEventUpgrade = (event) => {
  const name = event["name"]
  if (isJsonObject(name)) return event
  return {
    ...event,
    name:
      typeof name === "string" ? { kind: SESSION_NAME.named, name } : { kind: SESSION_NAME.unnamed }
  }
}

const contextSize = (tokens: unknown) =>
  typeof tokens === "number"
    ? { kind: CONTEXT_SIZE.measured, input_tokens: tokens }
    : { kind: CONTEXT_SIZE.unmeasured }

const countOr = (value: unknown): number => (typeof value === "number" ? value : 0)

const eventUsage = (usage: JsonObject): JsonObject => {
  if (isJsonObject(usage["cost"])) return usage
  const prompt = countOr(usage["prompt"])
  const completion = countOr(usage["completion"])
  const cacheRead = countOr(usage["cache_read"])
  const cacheWrite = countOr(usage["cache_write"])
  const cost = usage["cost"]
  return {
    ...withoutKeys(usage, ["cost", "exclusive_cost"]),
    prompt,
    completion,
    total:
      typeof usage["total"] === "number"
        ? usage["total"]
        : prompt + completion + cacheRead + cacheWrite,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    cost:
      typeof cost === "number"
        ? { kind: PROVIDER_COST.reported, usd: cost }
        : { kind: PROVIDER_COST.unreported }
  }
}

const runUsage = (event: JsonObject): JsonObject => {
  const usage = event["usage"]
  if (isJsonObject(usage) && usage["kind"] === RUN_USAGE.metered && isJsonObject(usage["usage"]))
    return { kind: RUN_USAGE.metered, usage: eventUsage(usage["usage"]) }
  if (isJsonObject(usage) && usage["kind"] === RUN_USAGE.unmetered) return usage
  return isJsonObject(usage)
    ? { kind: RUN_USAGE.metered, usage: eventUsage(usage) }
    : { kind: RUN_USAGE.unmetered }
}

const runFinished: StoredEventUpgrade = (event) => ({
  ...withoutKeys(event, ["context_input_tokens"]),
  usage: runUsage(event),
  context: "context" in event ? event["context"] : contextSize(event["context_input_tokens"]),
  message_count: countOr(event["message_count"])
})

const runError: StoredEventUpgrade = (event) => ({
  ...withoutKeys(event, ["debug_id", "recoverable"]),
  code: textOr(event["code"], "provider_error")
})

const tokenUsage: StoredEventUpgrade = (event) => {
  const usage = event["usage"]
  return {
    ...withoutKeys(event, ["context_input_tokens", "cost", "task_id", "child_run_id"]),
    usage: eventUsage(isJsonObject(usage) ? usage : {}),
    context: "context" in event ? event["context"] : contextSize(event["context_input_tokens"]),
    message_count: countOr(event["message_count"]),
    scope: textOr(event["scope"], "run")
  }
}

const runActivity: StoredEventUpgrade = (event) => {
  if ("target" in event) return event
  const ids = event["tool_call_ids"]
  return {
    ...withoutKeys(event, ["tool_call_ids"]),
    target: Array.isArray(ids)
      ? { kind: RUN_ACTIVITY_TARGET.calls, tool_call_ids: ids }
      : { kind: RUN_ACTIVITY_TARGET.run }
  }
}

const thinking: StoredEventUpgrade = (event) => ({
  ...event,
  run_id: textOr(event["run_id"], "")
})

const upgrades: Partial<Record<ChatProjectionEvent["type"], StoredEventUpgrade>> = {
  connection_needed: connectionNeeded,
  approval_needed: approvalNeeded,
  approval_resolved: withRoute,
  connection_resolved: withRoute,
  TEXT_MESSAGE_END: messageEnd,
  REASONING_MESSAGE_END: messageEnd,
  todo_updated: todoUpdated,
  RUN_STARTED: runStarted,
  session_updated: sessionUpdated,
  RUN_FINISHED: runFinished,
  RUN_ERROR: runError,
  token_usage: tokenUsage,
  run_activity: runActivity,
  thinking,
  ...storedToolEventUpgrades
}

const isKnownType = (type: string): type is ChatProjectionEvent["type"] =>
  Object.hasOwn(upgrades, type)

const upgradeStoredChatEvent = (data: unknown, sessionId: string): unknown => {
  if (!isJsonObject(data)) return data
  const type = data["type"]
  if (typeof type !== "string" || !isKnownType(type)) return data
  const upgrade = upgrades[type]
  return upgrade === undefined ? data : upgrade(data, sessionId)
}

export const decodeStoredChatEvent = (
  data: unknown,
  sessionId: string
): Effect.Effect<ChatProjectionEvent, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(ChatProjectionEventSchema)(upgradeStoredChatEvent(data, sessionId))
