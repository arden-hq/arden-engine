import { isComputerStep } from "@arden-hq/protocol/computer"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ToolResult } from "@arden-hq/loop"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"

import { ConversationArtifacts } from "../src/artifacts/conversation.js"
import { ManagedOutputs } from "../src/artifacts/managed-output/managed-output.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { makeToolResultObjects } from "../src/persistence/managed-output/tool-result-objects.js"
import { ToolResultObjects } from "../src/persistence/managed-output/tool-result-objects.js"
import { computerStepStates } from "../src/persistence/migrations/0192_computer_step_states.js"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { deleteSessionTree } from "../src/persistence/sqlite/session-tree-deletion.js"
import { readScriptExecutions } from "../src/persistence/sqlite/script-executions.js"
import { settleTerminalToolsInTransaction } from "../src/persistence/sqlite/tool-terminal.js"
import { ToolHistoryQueries } from "../src/persistence/tools/history-queries.js"
import { ToolExecutionStore, type ToolExecutionIdentity } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { SessionFileCleanup } from "../src/storage/session-file-cleanup.js"
import { inUnitOfWork } from "./fixtures/unit-of-work.js"

const IMAGE = {
  type: "image",
  media_type: "image/png",
  data: "iVBORw0KGgo".repeat(2_000)
} as const

const sqlFields = {
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

const largeResult: ToolResult = {
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

const smallResult: ToolResult = {
  content: "Done",
  preview: "Done",
  is_error: false,
  data: { exit_code: 0 }
}

interface Rig {
  readonly directory: string
  readonly filename: string
  readonly outputs: string
}

const withRig = async (body: (rig: Rig) => Promise<void>): Promise<void> => {
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

const storage = (rig: Rig, { slim }: { readonly slim: boolean }) =>
  Layer.merge(
    recoveredSqlitePersistenceLayer({
      dataDir: null,
      filename: rig.filename,
      managedOutputs: slim ? rig.outputs : undefined
    }).pipe(Layer.provide(PersistenceWriteQueue.layer)),
    SqliteClient.layer({ filename: rig.filename })
  )

const startRun = Effect.gen(function* () {
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

const identityOf = (
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

const settle = (identity: ToolExecutionIdentity, result: ToolResult) =>
  Effect.gen(function* () {
    const tools = yield* ToolExecutionStore
    yield* tools.begin(identity)
    return yield* tools.complete(identity, result)
  })

const storedRow = (toolCallId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly result_json: string }>`
      SELECT result_json FROM tool_calls WHERE tool_call_id = ${toolCallId}`
    const row = rows[0]
    if (row === undefined) return yield* Effect.die(`no row for ${toolCallId}`)
    return row.result_json
  })

const replayed = (identity: ToolExecutionIdentity) =>
  Effect.gen(function* () {
    const tools = yield* ToolExecutionStore
    const begun = yield* tools.begin(identity)
    if (begun._tag !== "Recovered") return yield* Effect.die("the call was not recovered")
    return begun.outcome.result
  })

const filesUnder = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true
  }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
}

describe("tool result storage", () => {
  it("restores tagged Computer steps from pre-upgrade inline and managed results", async () => {
    const screenshot = {
      image: `data:image/png;base64,${IMAGE.data}`,
      width: 320,
      height: 200,
      caption: "Looked at TextEdit"
    }
    const inline = {
      kind: "look",
      title: "Looked at the desktop",
      app: null,
      window: null,
      frames: []
    }
    const managed = {
      ...inline,
      title: "Looked at TextEdit",
      app: { name: "TextEdit", icon: "icon" },
      window: "Notes",
      frames: [screenshot]
    }
    await withRig(async (rig) => {
      const stored = await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* startRun
          for (const [toolCallId, computer] of [
            ["inline", inline],
            ["managed", managed]
          ] as const) {
            yield* settle(
              { ...identityOf(run, toolCallId), toolName: "computer_read" },
              {
                ...smallResult,
                data: { computer }
              }
            )
          }
          return { sessionId: run.sessionId, managedRow: yield* storedRow("managed") }
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      expect(JSON.parse(stored.managedRow)).toMatchObject({
        data: {},
        stored_result: { omitted: ["data.computer"], ref: expect.any(String) }
      })
      const database = new DatabaseSync(rig.filename)
      try {
        computerStepStates.up(database)
      } finally {
        database.close()
      }
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const history = yield* ToolHistoryQueries
          const metadata = yield* history.historyResultMetadata({
            sessionId: stored.sessionId,
            toolCallIds: ["inline", "managed"]
          })
          expect(yield* storedRow("managed")).toBe(stored.managedRow)
          return [
            metadata.get("inline")?.data?.["computer"],
            metadata.get("managed")?.data?.["computer"]
          ]
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      expect(results.map(isComputerStep)).toEqual([true, true])
      expect(results).toEqual([
        { ...inline, app: { kind: "unidentified" }, window: { kind: "untitled" } },
        {
          ...managed,
          app: { ...managed.app, kind: "identified" },
          window: { kind: "titled", title: "Notes" }
        }
      ])
    })
  })

  it("gives back a large result whole when it is completed and when the call is replayed", async () => {
    await withRig(async (rig) => {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* startRun
          const large = identityOf(run, "large")
          const small = identityOf(run, "small")
          return {
            completed: yield* settle(large, largeResult),
            replayed: yield* replayed(large),
            smallCompleted: yield* settle(small, smallResult),
            smallReplayed: yield* replayed(small)
          }
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      expect(out.completed).toEqual(largeResult)
      expect(out.replayed).toEqual(largeResult)
      expect(out.smallCompleted).toEqual(smallResult)
      expect(out.smallReplayed).toEqual(smallResult)
    })
  })

  it("knows a retried result by its digest and refuses a different one", async () => {
    await withRig(async (rig) => {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const tools = yield* ToolExecutionStore
          const run = yield* startRun
          const identity = identityOf(run, "large")
          yield* settle(identity, largeResult)
          const reordered: ToolResult = {
            model_content: [IMAGE],
            host: largeResult.host,
            data: { small: 1, ...sqlFields, text: "x".repeat(30_000) },
            retryable: null,
            is_error: false,
            preview: largeResult.preview,
            content: largeResult.content
          }
          const same = yield* tools.complete(identity, reordered)
          const different = yield* tools
            .complete(identity, {
              ...largeResult,
              content: `${largeResult.content}!`
            })
            .pipe(Effect.flip)
          const swapped = largeResult.content.replace("Résumé", "Rèsumé")
          const sameSize = yield* tools
            .complete(identity, { ...largeResult, content: swapped })
            .pipe(Effect.flip)
          return {
            same,
            different: { reason: different.reason },
            sameSize: { reason: sameSize.reason },
            sameBytes: Buffer.byteLength(swapped) === Buffer.byteLength(largeResult.content)
          }
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      expect(outcome).toEqual({
        same: largeResult,
        different: { reason: "conflict" },
        sameSize: { reason: "conflict" },
        sameBytes: true
      })
    })
  })

  it("sends the app the same data and host from a slim row, reading objects only when it must", async () => {
    const appResult: ToolResult = {
      content: "Ran the script.\n".repeat(3_000),
      preview: "Ran the script",
      is_error: false,
      data: {
        kind: "code_mode",
        phases: ["Review"],
        tools: Array.from({ length: 60 }, (_, index) => ({
          tool_call_id: `call-${index}`,
          name: "gmail_draft",
          args: "a".repeat(100)
        })),
        gmail_draft: { subject: "Hello", body: "b".repeat(5_000) },
        small: 1
      },
      host: { source_refs: [{ ref: "https://example.com", title: "Example" }] }
    }
    const contentOnly: ToolResult = {
      ...smallResult,
      content: "Long output.\n".repeat(3_000)
    }
    const objects = (rig: Rig) =>
      makeToolResultObjects(rig.outputs, {
        withLiveSession: (_, action) => action()
      })
    const read = (rig: Rig, slim: boolean, ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const run = yield* startRun
        yield* settle(identityOf(run, "app"), appResult)
        yield* settle(identityOf(run, "small"), smallResult)
        yield* settle(identityOf(run, "content"), contentOnly)
        const history = yield* ToolHistoryQueries
        const sessions = yield* SessionQueries
        const sql = yield* SqlClient.SqlClient
        const metadata = yield* history.historyResultMetadata({
          sessionId: run.sessionId,
          toolCallIds: [...ids]
        })
        const evidence = yield* sessions.readToolEvidence({
          sessionId: run.sessionId,
          limit: 10,
          contentChars: 1_000_000
        })
        const executions = yield* readScriptExecutions(sql, {
          originRunId: run.runId,
          originToolCallId: "app"
        }).pipe(Effect.provideService(ToolResultObjects, objects(rig)))
        return {
          metadata: ids.map((id) => {
            const entry = metadata.get(id)
            return entry === undefined
              ? undefined
              : {
                  isError: entry.isError,
                  retryable: entry.retryable,
                  data: entry.data
                }
          }),
          evidence: evidence.items.map((item) => [item.tool_call_id, item.payload.text]),
          executions
        }
      })
    const ids = ["app", "small", "content"]
    let slim: unknown
    let whole: unknown
    await withRig(async (rig) => {
      slim = await Effect.runPromise(
        read(rig, true, ids).pipe(Effect.provide(storage(rig, { slim: true })))
      )
    })
    await withRig(async (rig) => {
      whole = await Effect.runPromise(
        read(rig, false, ids).pipe(Effect.provide(storage(rig, { slim: false })))
      )
    })
    expect(slim).toEqual(whole)
    await withRig(async (rig) => {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* startRun
          yield* settle(identityOf(run, "small"), smallResult)
          yield* settle(identityOf(run, "content"), contentOnly)
          yield* settle(identityOf(run, "app"), appResult)
          yield* Effect.promise(() => rm(rig.outputs, { recursive: true, force: true }))
          const history = yield* ToolHistoryQueries
          const kept = yield* history.historyResultMetadata({
            sessionId: run.sessionId,
            toolCallIds: ["small", "content"]
          })
          const missing = yield* history
            .historyResultMetadata({
              sessionId: run.sessionId,
              toolCallIds: ["app"]
            })
            .pipe(Effect.flip)
          return { kept: [...kept.keys()].toSorted(), missing: missing.reason }
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      expect(outcome).toEqual({
        kept: ["content", "small"],
        missing: "storage"
      })
    })
  })

  it("rebuilds the same tool transcript from a slim row after a restart", async () => {
    await withRig(async (rig) => {
      const run = await Effect.runPromise(
        Effect.gen(function* () {
          const started = yield* startRun
          yield* settle(identityOf(started, "large"), largeResult)
          return started
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      const recovered = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const writes = yield* PersistenceWriteQueue
          const sessionEvents = yield* SessionLifecycleEvents
          return yield* writes.run(
            sql
              .withTransaction(
                inUnitOfWork(
                  settleTerminalToolsInTransaction(sql, {
                    ending: "process_restarted",
                    operation: "fail",
                    sessionId: run.sessionId,
                    runId: run.runId,
                    turnId: "turn-1",
                    terminalAt: "2026-11-13T00:10:00.000Z",
                    appendedMessages: [
                      {
                        message_id: "assistant-1",
                        role: ROLE.assistant,
                        created_at: "2026-11-13T00:00:01.000Z",
                        content: null,
                        tool_calls: [
                          {
                            id: "large",
                            type: "function",
                            function: {
                              name: "web_fetch",
                              arguments: JSON.stringify({
                                url: "https://example.com/start"
                              })
                            },
                            changes_state: false
                          }
                        ]
                      }
                    ],
                    activeMessages: [],
                    sessionEvents
                  })
                )
              )
              .pipe(
                Effect.provideService(
                  ToolResultObjects,
                  makeToolResultObjects(rig.outputs, {
                    withLiveSession: (_, action) => action()
                  })
                )
              )
          )
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      expect(recovered).toEqual([
        {
          message_id: expect.stringMatching(/^tool-recovered-/),
          role: ROLE.tool,
          created_at: expect.any(String),
          tool_call_id: "large",
          content: largeResult.content,
          model_content: [IMAGE]
        }
      ])
    })
  })

  it("removes the saved results with their chat", async () => {
    await withRig(async (rig) => {
      const cleanup = SessionFileCleanup.layer(path.join(rig.directory, "uploads")).pipe(
        Layer.provide(ManagedOutputs.layer(rig.outputs)),
        Layer.provide(ConversationArtifacts.layer(path.join(rig.directory, "conversations"))),
        Layer.provideMerge(storage(rig, { slim: true }))
      )
      const before = await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* startRun
          yield* settle(identityOf(run, "large"), largeResult)
          return run
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      const objects = await filesUnder(path.join(rig.outputs, "objects"))
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const writes = yield* PersistenceWriteQueue
          const sessionEvents = yield* SessionLifecycleEvents
          yield* sql`UPDATE chat_runs SET status = 'completed', stop_reason = 'completed',
            ended_at = updated_at WHERE run_id = ${before.runId}`
          yield* writes.run(
            sql.withTransaction(
              inUnitOfWork(
                deleteSessionTree(sql, sessionEvents, sql`session_id = ${before.sessionId}`)
              )
            )
          )
          const files = yield* SessionFileCleanup
          yield* files.drain()
        }).pipe(Effect.provide(cleanup))
      )
      expect(objects).toHaveLength(1)
      expect(await filesUnder(path.join(rig.outputs, "objects"))).toEqual([])
      expect(await filesUnder(path.join(rig.outputs, "refs"))).toEqual([])
    })
  })
})

it("a handler reads its whole result back from a slim row", async () => {
  const body = {
    paragraphs: [[{ text: "Ünïcode 🙂 ".repeat(1_200), source_id: null }]]
  }
  const content = JSON.stringify(body)
  await withRig(async (rig) => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* startRun
        const letter = {
          ...identityOf(run, "letter"),
          toolName: "publish_home_letter"
        }
        yield* settle(letter, {
          content,
          preview: "Home letter ready",
          data: { body }
        })
        return {
          slim: JSON.parse(yield* storedRow("letter")).stored_result !== undefined,
          read: yield* (yield* AutomationQueue).handlerToolResult({
            runId: run.runId,
            tool: "publish_home_letter"
          })
        }
      }).pipe(Effect.provide(storage(rig, { slim: true })))
    )
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(16 * 1024)
    expect(out).toEqual({ slim: true, read: content })
  })
})

it("a handler refuses a slim row whose digest does not name its saved object", async () => {
  const body = {
    paragraphs: [[{ text: "Ünïcode 🙂 ".repeat(1_200), source_id: null }]]
  }
  await withRig(async (rig) => {
    const reason = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const run = yield* startRun
        const letter = {
          ...identityOf(run, "letter"),
          toolName: "publish_home_letter"
        }
        yield* settle(letter, {
          content: JSON.stringify(body),
          preview: "Home letter ready",
          data: { body }
        })
        yield* sql`UPDATE tool_calls SET result_json = json_set(result_json, '$.stored_result.sha256',
          ${"0".repeat(64)}) WHERE tool_call_id = 'letter'`
        const failure = yield* (yield* AutomationQueue)
          .handlerToolResult({ runId: run.runId, tool: "publish_home_letter" })
          .pipe(Effect.flip)
        return Reflect.get(failure, "reason")
      }).pipe(Effect.provide(storage(rig, { slim: true })))
    )
    expect(reason).toBe("corrupt")
  })
})
