import type { HeadlessRunEvent } from "@arden-hq/headless"

import type { CliClient } from "../src/index.js"

type CancelInput = Parameters<CliClient["cancel"]>[0]
type CancelResponse = Awaited<ReturnType<CliClient["cancel"]>>

export const cancelling = (input: CancelInput): CancelResponse => {
  if (input.runId === undefined) throw new Error("the CLI cancels by run id")
  return { status: "cancelling", runId: input.runId, cancelRequested: true }
}

export const approvalNeeded = (toolId: string, runId = "run-1"): HeadlessRunEvent => ({
  event: "approval_needed",
  data: {
    type: "approval_needed",
    tool_id: toolId,
    name: "write_file",
    run_id: runId,
    session_id: "session-1"
  }
})

export const runEvent = (type: "RUN_STARTED" | "RUN_FINISHED"): HeadlessRunEvent => {
  switch (type) {
    case "RUN_STARTED":
      return {
        event: type,
        data: { type, run_id: "run-1", session_id: "session-1", turn_id: "turn-1" }
      }
    case "RUN_FINISHED":
      return {
        event: type,
        data: { type, run_id: "run-1", session_id: "session-1", turn_id: "turn-1" }
      }
  }
}

export const jsonLines = (text: string): Array<unknown> =>
  text
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line))

export type RunDetail = Awaited<ReturnType<CliClient["wait"]>>

type ListedSession = Awaited<ReturnType<CliClient["listSessions"]>>["sessions"][number]

export const listedSession = (messageCount: number): ListedSession => ({
  session_id: "session-1",
  name: null,
  started_at: "2026-08-30T00:00:00.000Z",
  last_activity: "2026-08-30T00:00:00.000Z",
  message_count: messageCount,
  presentation: { kind: "conversation", role: "topic" },
  public_ref: null,
  last_accessed_at: null,
  has_unread: false,
  space_id: null,
  chat_model: null,
  session_type: "chat",
  origin_automation_id: null,
  parent_session_id: null,
  parent_tool_call_id: null,
  parent_message_id: null,
  parent_run_id: null,
  active_run_id: null,
  active_turn_id: null,
  run_status: null,
  checkpoint_seq: 0,
  latest_event_seq: 0,
  is_active: false,
  pending_approvals_count: 0,
  pending_connections_count: 0,
  run_error_code: null,
  run_stop_reason: null
})

export const completedRun = (text = "Final answer"): RunDetail => ({
  version: 1,
  run_id: "run-1",
  turn_id: "turn-1",
  late_result_at: null,
  session_id: "session-1",
  status: "completed",
  started_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:01.000Z",
  ended_at: "2026-08-30T00:00:01.000Z",
  stop_reason: "stop",
  last_event_sequence: 2,
  model_id: "fixture-model",
  reasoning_effort: null,
  client_id: "client-1",
  result: {
    text,
    data: { verdict: "ok" },
    usage: { prompt: 4, completion: 2, total: 6, cache_read: 0, cache_write: 0 },
    cost: 0,
    duration_ms: 1_000,
    tool_time_ms: 0,
    steps: 1,
    last_input_tokens: 4
  },
  error: null
})

export const defaultClient = (): CliClient => ({
  createSession: async () => ({
    session_id: "session-1",
    name: "Arden CLI",
    started_at: "2026-08-30T00:00:00.000Z",
    last_activity: "2026-08-30T00:00:00.000Z",
    message_count: 0,
    space_id: null,
    chat_model: null,
    origin: null,
    parent_session_id: null,
    parent_message_id: null
  }),
  submit: async () => ({
    runId: "run-1",
    sessionId: "session-1",
    clientId: "client-1",
    status: "running"
  }),
  wait: async () => completedRun(),
  waitForRun: async () => completedRun(),
  cancel: async (input) => cancelling(input),
  health: async () => ({ status: "ok", version: "test", hasProviders: true }),
  deleteSession: async () => undefined,
  answerApproval: async () => undefined,
  answerConnection: async () => undefined,
  branchSession: async () => {
    throw new Error("branchSession is not stubbed")
  },
  listSessions: async () => {
    throw new Error("listSessions is not stubbed")
  },
  listSpaces: async () => {
    throw new Error("listSpaces is not stubbed")
  }
})
