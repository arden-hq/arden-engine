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

  it("reads an old message end's content and anchor as its closure and start", async () => {
    await expect(
      decode({ type: "TEXT_MESSAGE_END", message_id: "m-1", content: "Hi", content_start_seq: 4 })
    ).resolves.toEqual(
      expect.objectContaining({
        closure: { kind: "complete", content: "Hi" },
        content_start: { kind: "anchored", seq: 4 }
      })
    )
    await expect(decode({ type: "REASONING_MESSAGE_END", message_id: "m-2" })).resolves.toEqual(
      expect.objectContaining({
        closure: { kind: "abandoned" },
        content_start: { kind: "unanchored" }
      })
    )
  })

  it("reads an old todo update's explanation and call", async () => {
    await expect(
      decode({ type: "todo_updated", run_id: "run-1", explanation: "Why", items: [] })
    ).resolves.toEqual(
      expect.objectContaining({
        tool_call_id: "run-1",
        explanation: { kind: "given", text: "Why" }
      })
    )
  })

  it("reads an old approval request as its tagged states and default route", async () => {
    await expect(
      decode({
        type: "approval_needed",
        tool_id: "tool-1",
        name: "file_edit",
        content_preview: "Edit",
        run_id: "run-1",
        action: "write",
        grant_folder: "~/notes"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        session_id: "session-1",
        asked: { kind: "unrecorded" },
        preview: { kind: "preview", text: "Edit" },
        diff: { kind: "no_diff" },
        rule_places: [],
        can_attach_folder_to_space: false,
        grant_folder: { kind: "folder", folder: "~/notes" },
        card: { kind: "plain" },
        asker: { kind: "chat" },
        decision_route: { source_kind: "run", source_session_id: "session-1", basis: "source_v1" }
      })
    )
  })

  it("reads an old run start's causes, finish totals and failure code", async () => {
    await expect(
      decode({
        type: "RUN_STARTED",
        run_id: "run-1",
        session_id: "session-1",
        turn_id: "turn-1",
        is_meta_run: true,
        question_answer: { question_id: "q-1" },
        automation_task_id: "auto-1",
        automation_name: "Daily",
        automation_context_mode: "fresh"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        causes: [
          { kind: "question_answer", question_id: "q-1" },
          {
            kind: "automation",
            task_id: "auto-1",
            name: "Daily",
            prompt: { kind: "delegated" },
            context_mode: "fresh"
          }
        ]
      })
    )
    await expect(
      decode({ type: "RUN_FINISHED", run_id: "run-1", turn_id: "turn-1", message_count: 3 })
    ).resolves.toEqual(
      expect.objectContaining({
        usage: { kind: "unmetered" },
        context: { kind: "unmeasured" },
        message_count: 3
      })
    )
    await expect(
      decode({ type: "RUN_ERROR", run_id: "run-1", turn_id: "turn-1", message: "x" })
    ).resolves.toEqual(expect.objectContaining({ code: "provider_error" }))
  })
})
