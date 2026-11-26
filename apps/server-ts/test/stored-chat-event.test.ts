import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { decodeStoredChatEvent } from "../src/persistence/events/stored-chat-event.js"

const decode = (data: unknown) => Effect.runPromise(decodeStoredChatEvent(data, "session-1"))

const connectionNeeded = {
  type: "connection_needed",
  run_id: "run-1",
  tool_id: "tool-1",
  integration_id: "gmail",
  connection_id: "connection:run-1:tool-1",
  label: "Gmail",
  reason: "auth_required",
  detail: "Sign in again",
  capability: "send",
  action: "oauth",
  settings_tab: "connections",
  required_scopes: [],
  source: "recovery"
}

describe("stored chat events", () => {
  it("reads an old connection request's account and fills its chat", async () => {
    await expect(decode({ ...connectionNeeded, account_ref: "me@example.com" })).resolves.toEqual(
      expect.objectContaining({
        session_id: "session-1",
        account: { kind: "account", ref: "me@example.com" }
      })
    )
    const plain = await decode(connectionNeeded)
    expect(plain).toEqual(expect.objectContaining({ account: { kind: "default" } }))
    expect(plain).not.toHaveProperty("account_ref")
  })

  it("keeps a current connection request as written", async () => {
    const current = { ...connectionNeeded, session_id: "s-2", account: { kind: "default" } }
    await expect(decode(current)).resolves.toEqual(expect.objectContaining(current))
  })
})
