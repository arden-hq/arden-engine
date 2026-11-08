import { createTool, failedToolResult, ToolExecutionError } from "@arden-hq/loop"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { markRunToolExecutionsUncertainInTransaction } from "../src/persistence/sqlite/tool-receipts.js"
import { settleTerminalToolsInTransaction } from "../src/persistence/sqlite/tool-terminal.js"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import {
  attachMutationReceipt,
  ensureMutationReceipt,
  makeMutationReceipt,
  mutationOperationId,
  NOT_RUN_HOST,
  readMutationReceipt
} from "../src/persistence/tools/mutation-receipt.js"
import {
  confirmedToolOutcomeResult,
  rejectedToolResult,
  ToolExecutionStore,
  type ToolExecutionIdentity
} from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { inUnitOfWork } from "./fixtures/unit-of-work.js"

const identity = { runId: "run-1", toolCallId: "call-1" }

describe("mutation receipts", () => {
  it("builds strict file and generic version receipts", () => {
    const file = makeMutationReceipt({
      identity,
      outcome: "applied",
      resource: {
        kind: "file_revision",
        absolutePath: "/workspace/file.txt",
        beforeVersion: "before",
        afterVersion: "after"
      }
    })
    expect(file).toMatchObject({
      version: 1,
      operation_id: mutationOperationId(identity),
      outcome: "applied",
      resource_ref: "file:/workspace/file.txt",
      before_version: "before",
      after_version: "after",
      reconcile: { kind: "file_revision", absolute_path: "/workspace/file.txt" }
    })

    const versioned = makeMutationReceipt({
      identity,
      outcome: "no_op",
      resource: {
        kind: "versioned_resource",
        resourceRef: "research-workspace:session-1",
        beforeVersion: "3",
        afterVersion: "3"
      }
    })
    expect(versioned).toMatchObject({
      resource_ref: "research-workspace:session-1",
      before_version: "3",
      after_version: "3",
      reconcile: null
    })
  })

  it("downgrades missing, malformed, and cross-call receipts to unknown", () => {
    const result = { content: "changed", preview: "Changed" }
    expect(readMutationReceipt(ensureMutationReceipt(identity, result).host)?.outcome).toBe(
      "unknown"
    )
    expect(
      readMutationReceipt(
        ensureMutationReceipt(identity, {
          ...result,
          host: { mutation_receipt: { version: 1 } }
        }).host
      )?.outcome
    ).toBe("unknown")

    const crossCall = attachMutationReceipt(result, {
      identity: { ...identity, toolCallId: "other-call" },
      outcome: "applied",
      resource: { kind: "none" }
    })
    expect(readMutationReceipt(ensureMutationReceipt(identity, crossCall).host)?.outcome).toBe(
      "unknown"
    )

    const valid = attachMutationReceipt(result, {
      identity,
      outcome: "applied",
      resource: { kind: "none" }
    })
    expect(ensureMutationReceipt(identity, valid)).toBe(valid)
  })

  it("records a call its schema rejected as a no-op: the tool never ran", async () => {
    const tool = createTool({
      name: "space_task_infer",
      description: "Propose a Task.",
      parameters: Schema.toStandardSchemaV1(Schema.Struct({ decision: Schema.String })),
      metadata: { changes_state: true },
      execute: async () => {
        throw new Error("must not run")
      }
    })
    const rejected = await tool.execute(
      {},
      {
        toolCallId: identity.toolCallId,
        signal: new AbortController().signal,
        run: undefined,
        messages: []
      }
    )
    expect(readMutationReceipt(ensureMutationReceipt(identity, rejected).host)?.outcome).toBe(
      "no_op"
    )
  })

  it("records a call the approval gate held back as a no-op: it never ran", () => {
    const held = failedToolResult(
      new ToolExecutionError("This needs the user's approval, so it did not run now.", {
        host: NOT_RUN_HOST
      })
    )
    expect(readMutationReceipt(ensureMutationReceipt(identity, held).host)?.outcome).toBe("no_op")
  })

  it("records deterministic user resolutions", () => {
    expect(readMutationReceipt(rejectedToolResult(identity, null).host)?.outcome).toBe("no_op")
    expect(
      readMutationReceipt(confirmedToolOutcomeResult(identity, true, null).host)?.outcome
    ).toBe("applied")
    expect(
      readMutationReceipt(confirmedToolOutcomeResult(identity, false, null).host)?.outcome
    ).toBe("no_op")
  })

  it("persists and replays identity-bound mutation receipts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "arden-mutation-receipt-"))
    const filename = path.join(directory, "arden.db")
    const storage = Layer.merge(
      recoveredSqlitePersistenceLayer({ dataDir: null, filename }).pipe(
        Layer.provide(PersistenceWriteQueue.layer)
      ),
      SqliteClient.layer({ filename })
    )
    try {
      const outcomes = await Effect.runPromise(
        Effect.gen(function* () {
          const chat = yield* ChatWriteStore
          const sessions = yield* SessionStore
          const sql = yield* SqlClient.SqlClient
          const tools = yield* ToolExecutionStore
          const writes = yield* PersistenceWriteQueue
          const session = yield* sessions.create({ name: "Mutation receipts" })
          const started = yield* chat.start({
            sessionId: session.sessionId,
            clientId: "client-1",
            requestHash: "hash-1",
            assistantMessageId: "assistant-1",
            message: {
              message_id: "client-1",
              client_id: "client-1",
              role: "user",
              content: "Test mutation receipts",
              created_at: "2026-08-30T00:00:00.000Z"
            }
          })
          if (started._tag !== "Started") return yield* Effect.die("run did not start")

          const bareIdentity: ToolExecutionIdentity = {
            runId: started.runId,
            sessionId: session.sessionId,
            toolCallId: "bare",
            toolName: "state_change",
            arguments: {},
            changesState: true
          }
          yield* tools.begin(bareIdentity)
          const bare = yield* tools.complete(bareIdentity, {
            content: "Changed",
            preview: "Changed"
          })

          const evidencedIdentity = { ...bareIdentity, toolCallId: "evidenced" }
          yield* tools.begin(evidencedIdentity)
          const evidenced = yield* tools.complete(
            evidencedIdentity,
            attachMutationReceipt(
              {
                content: "Changed safely",
                preview: "Changed safely"
              },
              {
                identity: evidencedIdentity,
                outcome: "applied",
                resource: { kind: "none" }
              }
            )
          )
          const uncertainIdentity: ToolExecutionIdentity = {
            ...bareIdentity,
            toolCallId: "uncertain"
          }
          yield* tools.begin(uncertainIdentity)
          yield* writes.run(
            sql.withTransaction(
              markRunToolExecutionsUncertainInTransaction(
                sql,
                started.runId,
                "9999-12-31T23:59:59.999Z",
                "run_ended"
              )
            )
          )
          const replayed = (yield* tools.recover([uncertainIdentity])).get("uncertain")
          if (replayed?.status !== "uncertain") {
            return yield* Effect.die("bulk-settled mutation did not replay as uncertain")
          }
          return {
            bare,
            evidenced,
            uncertain: replayed.result,
            uncertainOperationId: mutationOperationId(uncertainIdentity),
            replayed
          }
        }).pipe(Effect.provide(storage))
      )

      expect(readMutationReceipt(outcomes.bare.host)?.outcome).toBe("unknown")
      expect(readMutationReceipt(outcomes.evidenced.host)?.outcome).toBe("applied")
      expect(readMutationReceipt(outcomes.uncertain.host)).toMatchObject({
        operation_id: outcomes.uncertainOperationId,
        outcome: "unconfirmed"
      })
      expect(outcomes.replayed).toEqual({ status: "uncertain", result: outcomes.uncertain })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("leaves a background script's running calls to the script when its turn ends", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "arden-detached-terminal-"))
    const filename = path.join(directory, "arden.db")
    const storage = () =>
      Layer.merge(
        recoveredSqlitePersistenceLayer({ dataDir: null, filename }).pipe(
          Layer.provide(PersistenceWriteQueue.layer)
        ),
        SqliteClient.layer({ filename })
      )
    const statuses = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly tool_call_id: string; readonly status: string }>`
        SELECT tool_call_id, status FROM tool_calls ORDER BY tool_call_id`
      return Object.fromEntries(rows.map((row) => [row.tool_call_id, row.status]))
    })
    try {
      const afterTurn = await Effect.runPromise(
        Effect.gen(function* () {
          const chat = yield* ChatWriteStore
          const sessions = yield* SessionStore
          const sql = yield* SqlClient.SqlClient
          const tools = yield* ToolExecutionStore
          const writes = yield* PersistenceWriteQueue
          const session = yield* sessions.create({ name: "Background script" })
          const started = yield* chat.start({
            sessionId: session.sessionId,
            clientId: "client-1",
            requestHash: "hash-1",
            assistantMessageId: "assistant-1",
            message: {
              message_id: "client-1",
              client_id: "client-1",
              role: "user",
              content: "Read the timeline",
              created_at: "2026-10-24T00:00:00.000Z"
            }
          })
          if (started._tag !== "Started") return yield* Effect.die("run did not start")
          const row = (toolCallId: string, toolName: string) =>
            sql`INSERT INTO tool_calls (run_id, session_id, tool_call_id, tool_name, arguments_json, changes_state, effect, status, started_at)
              VALUES (${started.runId}, ${session.sessionId}, ${toolCallId}, ${toolName}, '{}', 1, 'external', 'running', '2026-10-24T00:00:01.000Z')`
          yield* row("script", "code_mode")
          yield* sql`UPDATE tool_calls SET status = 'completed', ended_at = '2026-10-24T00:00:01.500Z',
            result_json = '{"content":"Moved to the background","preview":"Moved to the background","is_error":false}'
            WHERE run_id = ${started.runId} AND tool_call_id = 'script'`
          yield* row("script:code:press:0", "browser_act")
          yield* row("plain", "browser_act")
          yield* writes.run(
            sql.withTransaction(
              inUnitOfWork(
                settleTerminalToolsInTransaction(sql, {
                  ending: "run_ended",
                  operation: "finish",
                  sessionId: session.sessionId,
                  runId: started.runId,
                  turnId: "turn-1",
                  terminalAt: "2026-10-24T00:00:02.000Z",
                  activeMessages: [],
                  appendedMessages: [],
                  sessionEvents: yield* SessionLifecycleEvents
                })
              )
            )
          )
          yield* sql`UPDATE chat_runs SET status = 'completed', stop_reason = 'completed',
            ended_at = updated_at WHERE run_id = ${started.runId}`
          yield* tools.target({
            runId: started.runId,
            toolCallId: "script:code:press:0",
            target: { source: "browser", objectId: "tab-1" },
            origin: "named"
          })
          return yield* statuses
        }).pipe(Effect.provide(storage()))
      )
      expect(afterTurn).toEqual({
        plain: "uncertain",
        script: "completed",
        "script:code:press:0": "running"
      })
      const afterRestart = await Effect.runPromise(statuses.pipe(Effect.provide(storage())))
      expect(afterRestart["script:code:press:0"]).toBe("uncertain")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
