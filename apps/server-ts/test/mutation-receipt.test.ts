import { ROLE } from "@arden-hq/std/message-vocabulary"
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
import {
  attachMutationReceipt,
  ensureMutationReceipt,
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

const identity = { runId: "run-1", toolCallId: "call-1" }

describe("mutation receipts", () => {
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

    const own = attachMutationReceipt(result, {
      identity,
      outcome: "applied",
      resource: { kind: "none" }
    })
    const tamper = (change: Record<string, unknown>) => ({
      ...own,
      host: { mutation_receipt: { ...readMutationReceipt(own.host), ...change } }
    })
    expect(
      readMutationReceipt(
        ensureMutationReceipt(identity, tamper({ receipt_ref: "tool-call:other:other" })).host
      )?.outcome
    ).toBe("unknown")
    expect(
      readMutationReceipt(ensureMutationReceipt(identity, tamper({ unexpected: true })).host)
        ?.outcome
    ).toBe("unknown")

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
              role: ROLE.user,
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
})
