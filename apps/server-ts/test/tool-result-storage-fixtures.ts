import type { ToolResult } from "@arden-hq/loop"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import type { ToolExecutionIdentity } from "../src/persistence/tools/store.js"

export const IMAGE = {
  type: "image",
  media_type: "image/png",
  data: "iVBORw0KGgo".repeat(2_000)
} as const

export const sqlFields = {
  applied_change: {
    type: "file_edit",
    patch: `+${"line\n".repeat(700)}`,
    truncated: false
  },
  attachment_id: "attachment-1",
  automation_ref: "automation-1",
  comment: { comment_id: "comment-1", body: "c".repeat(3_000) },
  decision: "propose",
  exit_code: 0,
  final_url: "https://example.com/final",
  finish_check: { item_id: "item-1", closed: 0, note: "n".repeat(3_000) },
  outcome: "done",
  proposal: { proposal_id: "proposal-1", body: "p".repeat(3_000) },
  requested_url: "https://example.com/start",
  source_refs: Array.from({ length: 40 }, (_, index) => ({
    ref: `https://example.com/${index}`,
    title: "t".repeat(100)
  }))
}

export const largeResult: ToolResult = {
  content: `${"Résumé of the page, line by line.\n".repeat(1_500)}🙂 end`,
  preview: "Read the page",
  is_error: false,
  retryable: null,
  data: { ...sqlFields, text: "x".repeat(30_000), small: 1 },
  host: {
    refusal: { reason: "r".repeat(3_000) },
    mutation_receipt: { outcome: "applied", detail: "d".repeat(3_000) }
  },
  model_content: [IMAGE]
}

export const smallResult: ToolResult = {
  content: "Done",
  preview: "Done",
  is_error: false,
  data: { exit_code: 0 }
}

export interface Rig {
  readonly directory: string
  readonly filename: string
  readonly outputs: string
}

export const withRig = async (body: (rig: Rig) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), "arden-tool-results-"))
  try {
    await body({
      directory,
      filename: path.join(directory, "arden.db"),
      outputs: path.join(directory, "managed-outputs")
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export const startRun = Effect.gen(function* () {
  const chat = yield* ChatWriteStore
  const sessions = yield* SessionStore
  const session = yield* sessions.create({ name: "Tool results" })
  const started = yield* chat.start({
    sessionId: session.sessionId,
    clientId: "client-1",
    requestHash: "hash-1",
    assistantMessageId: "assistant-1",
    message: {
      message_id: "client-1",
      client_id: "client-1",
      role: ROLE.user,
      content: "Read the page",
      created_at: "2026-11-13T00:00:00.000Z"
    }
  })
  if (started._tag !== "Started") return yield* Effect.die("run did not start")
  const sql = yield* SqlClient.SqlClient
  const turns = yield* sql<{ readonly turn_id: string }>`
    SELECT json_extract(metadata_json, '$.turn_id') AS turn_id FROM chat_runs
    WHERE run_id = ${started.runId}`
  return {
    sessionId: session.sessionId,
    runId: started.runId,
    turnId: turns[0]?.turn_id ?? ""
  }
})

export const identityOf = (
  run: { readonly sessionId: string; readonly runId: string },
  toolCallId: string
): ToolExecutionIdentity => ({
  runId: run.runId,
  sessionId: run.sessionId,
  toolCallId,
  toolName: "web_fetch",
  arguments: { url: "https://example.com/start" },
  changesState: false
})
