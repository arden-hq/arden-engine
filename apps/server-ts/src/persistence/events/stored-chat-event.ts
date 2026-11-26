import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { CONNECTION_ACCOUNT } from "@arden-hq/protocol/chat"
import { ChatProjectionEventSchema } from "@arden-hq/protocol/effect/chat"
import { type Effect, Schema } from "effect"
import { isJsonObject, type JsonObject } from "../json.js"

type StoredEventUpgrade = (event: JsonObject, sessionId: string) => JsonObject

const withoutKeys = (event: JsonObject, keys: ReadonlyArray<string>): JsonObject =>
  Object.fromEntries(Object.entries(event).filter(([key]) => !keys.includes(key)))

const connectionNeeded: StoredEventUpgrade = (event, sessionId) => {
  if ("account" in event) return event
  const ref = event["account_ref"]
  return {
    ...withoutKeys(event, ["account_ref"]),
    session_id: typeof event["session_id"] === "string" ? event["session_id"] : sessionId,
    account:
      typeof ref === "string"
        ? { kind: CONNECTION_ACCOUNT.account, ref }
        : { kind: CONNECTION_ACCOUNT.default }
  }
}

const upgrades: Partial<Record<ChatProjectionEvent["type"], StoredEventUpgrade>> = {
  connection_needed: connectionNeeded
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
