import type { HeadlessRunEvent } from "@arden-hq/headless"
import type { ToolCatalogEntry, ToolDisplay } from "@arden-hq/protocol/tools"

import type { CliClient } from "../src/index.js"

type WaitOptions = Parameters<CliClient["wait"]>[1]

export const emit = async (options: WaitOptions, event: HeadlessRunEvent): Promise<void> => {
  await options?.onEvent?.(event, options.signal ?? new AbortController().signal)
}

export const catalogEntry = (name: string, display: ToolDisplay): ToolCatalogEntry => ({
  name,
  displayName: name,
  description: "",
  kind: "tool",
  source: "arden",
  effectivePolicy: {
    action: "read",
    scope: "external",
    requiresApproval: true,
    permissions: []
  },
  defaultApproval: "ask",
  display
})

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
    session_id: "session-1",
    asked: { kind: "unrecorded" },
    preview: { kind: "no_preview" },
    diff: { kind: "no_diff" },
    action: "write",
    rule_places: [],
    can_attach_folder_to_space: false,
    grant_folder: { kind: "none" },
    card: { kind: "plain" },
    decision_route: { source_kind: "run", source_session_id: "session-1", basis: "source_v1" },
    asker: { kind: "chat" }
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
  public_ref: "ref-1",
  name: { kind: "unnamed" },
  started_at: "2026-08-30T00:00:00.000Z",
  last_activity: "2026-08-30T00:00:00.000Z",
  message_count: messageCount,
  presentation: { kind: "conversation", role: "topic" },
  has_unread: false,
  space: { kind: "none" },
  chat_model: { kind: "inherited" },
  session_type: "chat",
  origin_automation: { kind: "none" },
  parent: { kind: "none" },
  run: { kind: "none" },
  checkpoint_seq: 0,
  latest_event_seq: 0,
  pending_approvals_count: 0,
  pending_connections_count: 0,
  triage: { kind: "none" },
  fork: { kind: "none" },
  thread_source: { kind: "none" },
  origin: "ordinary",
  current_activity: { kind: "idle" },
  summary: { kind: "none" },
  agent_workspace: { kind: "none" }
})

export const completedRun = (text = "Final answer"): RunDetail => ({
  version: 1,
  run_id: "run-1",
  turn_id: "turn-1",
  session_id: "session-1",
  status: "completed",
  started_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:01.000Z",
  ended_at: "2026-08-30T00:00:01.000Z",
  stop_reason: { kind: "stated", reason: "stop" },
  events: { kind: "through", sequence: 2 },
  model: { kind: "model", model_id: "fixture-model" },
  reasoning: { kind: "default" },
  client: { kind: "client", client_id: "client-1" },
  local_instructions: [],
  memory_context: [],
  result: {
    kind: "on_time",
    result: {
      text,
      data: { verdict: "ok" },
      usage: {
        prompt: 4,
        completion: 2,
        total: 6,
        cache_read: 0,
        cache_write: 0,
        cost: { kind: "reported", usd: 0 }
      },
      duration_ms: 1_000,
      tool_time_ms: 0,
      steps: 1,
      context: { kind: "measured", input_tokens: 4 }
    }
  },
  failure: { kind: "none" }
})

export const defaultClient = (): CliClient => ({
  createSession: async () => ({
    session_id: "session-1",
    name: { kind: "named", name: "Arden CLI" },
    started_at: "2026-08-30T00:00:00.000Z",
    last_activity: "2026-08-30T00:00:00.000Z",
    message_count: 0,
    space: { kind: "none" },
    chat_model: { kind: "inherited" },
    origin: "ordinary"
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
  toolCatalog: async () => ({ tools: [catalogEntry("write_file", [])], unlisted: {} }),
  answerQuestion: async () => {
    throw new Error("answerQuestion is not stubbed")
  },
  branchSession: async () => {
    throw new Error("branchSession is not stubbed")
  },
  listSessions: async () => {
    throw new Error("listSessions is not stubbed")
  },
  listSpaces: async () => {
    throw new Error("listSpaces is not stubbed")
  },
  listModels: async () => ({
    providers: [
      {
        id: "llama.cpp",
        name: "llama.cpp",
        models: [{ id: "gemma-4", name: "gemma-4", reasoningEfforts: ["none", "medium"] }]
      }
    ]
  })
})
