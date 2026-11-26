import { Schema } from "effect"
import { expect, it } from "vitest"
import { SessionListItemSchema } from "@arden-hq/protocol/effect/sessions"
import { todaySession } from "../src/persistence/migrations/0200_session_snapshot_states.js"

const base = {
  session_id: "s1",
  public_ref: "ref-1",
  started_at: "2026-11-01T10:00:00.000Z",
  last_activity: "2026-11-01T11:00:00.000Z",
  last_accessed_at: null,
  has_unread: false,
  message_count: 3,
  session_type: "chat",
  checkpoint_seq: 0,
  latest_event_seq: 4,
  pending_approvals_count: 0,
  pending_connections_count: 0,
  run_error_code: null,
  run_stop_reason: null
}

const STORED = [
  {
    ...base,
    presentation: { kind: "conversation", role: "topic" },
    name: null,
    space_id: null,
    chat_model: null,
    origin_automation_id: null,
    parent_session_id: null,
    parent_tool_call_id: null,
    parent_message_id: null,
    parent_run_id: null,
    parent_step: { kind: "none" },
    active_run_id: null,
    active_turn_id: null,
    latest_run_id: null,
    run_status: null,
    is_active: false,
    triage: null,
    fork: null,
    thread_source: null,
    origin: null
  },
  {
    ...base,
    session_type: "agent",
    presentation: { kind: "execution", label: "Agent", title: "Agent", owner: null },
    name: "Worker",
    space_id: "sp1",
    chat_model: "gemma-4",
    origin_automation_id: "a1",
    parent_session_id: "p1",
    parent_tool_call_id: "call-1",
    parent_message_id: null,
    parent_run_id: "r0",
    parent_step: { kind: "step", tool_call_id: "call-0" },
    active_run_id: "r1",
    active_turn_id: "t1",
    latest_run_id: "r1",
    run_status: "running",
    is_active: true,
    fork: { at: "2026-11-01T10:30:00.000Z", turn_id: "t0" },
    thread_source: { session_id: "src", session_ref: null },
    origin: "capture"
  }
]

it("every stored session snapshot decodes as tagged states after the migration", () => {
  const migrated = STORED.map(todaySession)
  const decoded = migrated.map((session) =>
    Schema.decodeUnknownSync(SessionListItemSchema)(session)
  )
  expect(decoded[0]).toMatchObject({
    name: { kind: "unnamed" },
    space: { kind: "none" },
    parent: { kind: "none" },
    run: { kind: "none" },
    triage: { kind: "none" },
    origin: "ordinary"
  })
  expect(decoded[1]).toMatchObject({
    name: { kind: "named", name: "Worker" },
    space: { kind: "space", space_id: "sp1" },
    chat_model: { kind: "pinned", model_id: "gemma-4" },
    origin_automation: { kind: "automation", automation_id: "a1" },
    parent: { kind: "agent", session_id: "p1", run_id: "r0", tool_call_id: "call-1" },
    run: { kind: "active", run_id: "r1", turn_id: "t1", status: "running" },
    fork: { kind: "fork", turn_id: "t0" },
    thread_source: { kind: "gone", session_id: "src" },
    presentation: { owner: { kind: "none" } },
    origin: "capture"
  })
  expect(migrated.map(todaySession)).toEqual(migrated)
})
