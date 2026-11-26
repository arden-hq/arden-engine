import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { runDecoders } from "@arden-hq/protocol/runs"
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

  it("reads an old run's usage with its total and its reported or unreported cost", async () => {
    await expect(
      decode({
        type: "RUN_FINISHED",
        run_id: "run-1",
        turn_id: "turn-1",
        message_count: 1,
        usage: { prompt: 5, completion: 2, total: 7, cache_read: 0, cache_write: 0, cost: 0.5 }
      })
    ).resolves.toEqual(
      expect.objectContaining({
        usage: {
          kind: "metered",
          usage: {
            prompt: 5,
            completion: 2,
            total: 7,
            cache_read: 0,
            cache_write: 0,
            cost: { kind: "reported", usd: 0.5 }
          }
        }
      })
    )
    await expect(
      decode({
        type: "token_usage",
        run_id: "run-1",
        scope: "run",
        message_count: 1,
        context: { kind: "measured", input_tokens: 9 },
        usage: { prompt: 4, completion: 1, cache_read: 3, cache_write: 1 }
      })
    ).resolves.toEqual(
      expect.objectContaining({
        usage: {
          prompt: 4,
          completion: 1,
          total: 9,
          cache_read: 3,
          cache_write: 1,
          cost: { kind: "unreported" }
        }
      })
    )
  })
})

describe("stored tool events", () => {
  it("reads an old tool start's face and an old result's retry, data and receipt", async () => {
    await expect(
      decode({
        type: "TOOL_CALL_START",
        tool_call_id: "call-1",
        tool_call_name: "read",
        parent_id: null,
        display_title: "notes.md",
        icon: null,
        presentation: "conversation"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        parent: { kind: "root" },
        display_name: "read",
        title: { kind: "titled", text: "notes.md" },
        kind: "tool",
        icon: { kind: "plain" },
        noun: { kind: "unnamed" },
        source: { kind: "unsourced" },
        presentation: "conversation",
        execution: "runtime"
      })
    )
    await expect(
      decode({
        type: "TOOL_CALL_RESULT",
        tool_call_id: "call-1",
        name: "read",
        content: "text",
        is_error: false,
        retryable: false,
        data: { rows: 1 },
        execution: "provider"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        retry: "final",
        data: { kind: "attached", value: { rows: 1 } },
        source_refs: [],
        gmail_send: { kind: "unconfirmed" },
        execution: "provider"
      })
    )
    await expect(
      decode({ type: "TOOL_CALL_PROGRESS", tool_call_id: "call-1", message: "working" })
    ).resolves.toEqual(expect.objectContaining({ data: { kind: "none" }, execution: "runtime" }))
  })

  it("upgrades an old question in a tool result's data to the question the routes send", async () => {
    const question = {
      question_id: "q",
      run_id: "r",
      turn_id: "t",
      session_id: "c",
      destination_session_id: "c",
      context: { origin: { kind: "chat", session_id: "c", turn_id: "t" }, task: null },
      content: { prompt: "Which?", detail: null, choices: [{ id: "a", label: "A" }] },
      status: "open",
      resolution: null,
      continuation: null,
      focus_choice: null,
      permission_offer: null,
      continuity_revision: null,
      created_at: "2026-11-24T00:00:00.000Z"
    }
    const event = await decode({
      type: "TOOL_CALL_RESULT",
      tool_call_id: "call-1",
      name: "ask_user_input",
      content: "asked",
      data: { question }
    })
    const decoded = runDecoders.question(
      event.type === "TOOL_CALL_RESULT" && event.data.kind === "attached"
        ? event.data.value["question"]
        : undefined
    )
    expect(decoded.content.detail).toEqual({ kind: "none" })
    expect(decoded.resolution).toEqual({ kind: "unresolved" })
  })

  it("reads an old run cause's sender and agent result as tagged states", async () => {
    const event = await decode({
      type: "RUN_STARTED",
      run_id: "run-1",
      session_id: "session-1",
      turn_id: "turn-1",
      interaction: {
        kind: "message",
        from: { source: "agent", id: "c-2", name: "Researcher" },
        caused_by: { type: "tool_call", id: "call-1" },
        content: "done"
      },
      agent_result: { session_id: "c-2", name: "Researcher", content: "report" }
    })
    expect(event).toEqual(
      expect.objectContaining({
        causes: [
          {
            kind: "agent_result",
            agent_result: {
              session_id: "c-2",
              name: "Researcher",
              content: "report",
              preview: { kind: "unpreviewed" }
            }
          },
          {
            kind: "interaction",
            interaction: {
              kind: "message",
              from: { source: "agent", id: "c-2", name: { kind: "named", text: "Researcher" } },
              to: { kind: "unaddressed" },
              preview: { kind: "unpreviewed" },
              caused_by: { kind: "traced", reference: { type: "tool_call", id: "call-1" } },
              content: "done"
            }
          }
        ]
      })
    )
  })

  it("reads an old approval card's presentation in the card shape the stream sends", async () => {
    const event = await decode({
      type: "approval_needed",
      tool_id: "tool-1",
      run_id: "run-1",
      session_id: "session-1",
      name: "write",
      asked: { kind: "recorded", at: "2026-11-24T00:00:00.000Z" },
      preview: { kind: "no_preview" },
      diff: { kind: "no_diff" },
      card: {
        kind: "presented",
        presentation: {
          title: "Write notes.md",
          fields: [{ label: "Path", value: "notes.md", from: "old.md" }],
          note: "Outside the folders"
        }
      },
      asker: { kind: "chat" },
      grant_folder: { kind: "none" },
      action: "write",
      rule_places: [],
      can_attach_folder_to_space: false,
      decision_route: { source_kind: "run", source_session_id: "session-1", basis: "source_v1" }
    })
    expect(event).toEqual(
      expect.objectContaining({
        card: {
          kind: "presented",
          presentation: expect.objectContaining({
            title: "Write notes.md",
            subject: { kind: "none" },
            fields: [
              { label: "Path", value: "notes.md", from: { kind: "previous", text: "old.md" } }
            ],
            note: { kind: "text", text: "Outside the folders" },
            body: { kind: "none" },
            editable: { kind: "fixed" },
            image: { kind: "none" },
            attachments: []
          })
        }
      })
    )
  })
})
