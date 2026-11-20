import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ToolResult } from "@arden-hq/loop"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { engineOrderedJson } from "@arden-hq/std/json"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { ConversationArtifacts } from "../src/artifacts/conversation.js"
import { ManagedOutputs } from "../src/artifacts/managed-output/managed-output.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { makeToolResultObjects } from "../src/persistence/managed-output/tool-result-objects.js"
import { ToolResultObjects } from "../src/persistence/managed-output/tool-result-objects.js"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { makeBackfillChunks } from "../src/persistence/sqlite/backfills/store.js"
import { makeWriter } from "../src/persistence/sqlite/deps.js"
import { deleteSessionTree } from "../src/persistence/sqlite/session-tree-deletion.js"
import { readScriptExecutions } from "../src/persistence/sqlite/script-executions.js"
import { slimToolResultsBackfill } from "../src/persistence/sqlite/tool-result-backfill.js"
import { settleTerminalToolsInTransaction } from "../src/persistence/sqlite/tool-terminal.js"
import { ToolHistoryQueries } from "../src/persistence/tools/history-queries.js"
import { ToolExecutionStore, type ToolExecutionIdentity } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { SessionFileCleanup } from "../src/storage/session-file-cleanup.js"
import { inUnitOfWork } from "./fixtures/unit-of-work.js"

const IMAGE = { type: "image", media_type: "image/png", data: "iVBORw0KGgo".repeat(2_000) } as const

/** Every data field SQL reads in place, each but the plain ones over the 2 KB a slim row keeps. */
const sqlFields = {
  applied_change: { type: "file_edit", patch: `+${"line\n".repeat(700)}`, truncated: false },
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

/** Storage as the server opens it; `slim: false` is a build from before slim rows. */
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
  return { sessionId: session.sessionId, runId: started.runId, turnId: turns[0]?.turn_id ?? "" }
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

/** Every `result_json` path the engine's SQL reads, found in the source, but the slim-row marker. */
const sqlReadPaths = (): ReadonlyArray<string> => {
  const found = new Set<string>()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const file = path.join(directory, entry)
      if (entry === "migrations") continue
      if (statSync(file).isDirectory()) walk(file)
      else if (file.endsWith(".ts"))
        for (const match of readFileSync(file, "utf8").matchAll(/result_json, '(\$[^']*)'/g))
          if (match[1] !== undefined && !match[1].startsWith("$.stored_result")) found.add(match[1])
    }
  }
  walk(path.join(import.meta.dirname, "../src"))
  return [...found].toSorted()
}

const extract = (json: string, jsonPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly value: unknown }>`
      SELECT json_extract(${json}, ${jsonPath}) AS value`
    return rows[0]?.value
  })

const filesUnder = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
}

describe("tool result storage", () => {
  it("keeps a large result whole as an object and a slim row in its place", async () => {
    await withRig(async (rig) => {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* startRun
          const large = identityOf(run, "large")
          const small = identityOf(run, "small")
          return {
            completed: yield* settle(large, largeResult),
            row: yield* storedRow("large"),
            replayed: yield* replayed(large),
            smallCompleted: yield* settle(small, smallResult),
            smallRow: yield* storedRow("small")
          }
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      const whole = engineOrderedJson(largeResult)
      const slim = JSON.parse(out.row) as {
        readonly content: string
        readonly stored_result: { readonly ref: string }
      }
      const marker = slim.stored_result
      const digest = marker.ref.split("/")[2] ?? ""
      expect(largeResult.content.startsWith(slim.content)).toBe(true)
      expect(Buffer.byteLength(slim.content, "utf8")).toBeGreaterThan(4_092)
      expect(Buffer.byteLength(slim.content, "utf8")).toBeLessThanOrEqual(4_096)
      expect(slim).toEqual({
        content: slim.content,
        preview: "Read the page",
        is_error: false,
        retryable: null,
        data: { ...sqlFields, small: 1 },
        host: largeResult.host,
        model_content: [],
        stored_result: {
          ref: marker.ref,
          sha256: digest,
          bytes: Buffer.byteLength(whole, "utf8"),
          content_chars: [...largeResult.content].length,
          omitted: ["data.text"]
        }
      })
      expect(
        await readFile(path.join(rig.outputs, "objects", digest.slice(0, 2), digest), "utf8")
      ).toBe(whole)
      expect(out.completed).toEqual(largeResult)
      expect(engineOrderedJson(out.replayed)).toBe(whole)
      expect(out.smallCompleted).toEqual(smallResult)
      expect(JSON.parse(out.smallRow)).toEqual(smallResult)
    })
  })

  it("leaves every field SQL reads in place on the slim row", async () => {
    await withRig(async (rig) => {
      const paths = sqlReadPaths()
      expect(paths).toEqual(
        expect.arrayContaining([
          "$.is_error",
          "$.host.refusal",
          "$.host.mutation_receipt.outcome",
          "$.data.exit_code",
          "$.data.requested_url",
          "$.data.final_url"
        ])
      )
      const compared = await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* startRun
          yield* settle(identityOf(run, "large"), largeResult)
          const slim = yield* storedRow("large")
          const whole = JSON.stringify(largeResult)
          // `$.content` keeps its head and `$.data` the fields that fit; both are checked below.
          const exact = paths.filter(
            (jsonPath) => jsonPath !== "$.content" && jsonPath !== "$.data"
          )
          return {
            slim,
            fields: yield* Effect.forEach(exact, (jsonPath) =>
              Effect.all({
                path: Effect.succeed(jsonPath),
                slim: extract(slim, jsonPath),
                whole: extract(whole, jsonPath)
              })
            ),
            contentChars: yield* extract(slim, "$.stored_result.content_chars"),
            wholeChars: yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const rows = yield* sql<{ readonly n: number }>`
                SELECT length(${largeResult.content}) AS n`
              return rows[0]?.n
            })
          }
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      for (const field of compared.fields) {
        expect({ path: field.path, value: field.slim }).toEqual({
          path: field.path,
          value: field.whole
        })
      }
      expect(compared.contentChars).toBe(compared.wholeChars)
      const content = (JSON.parse(compared.slim) as { readonly content: string }).content
      expect(largeResult.content.startsWith(content)).toBe(true)
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
            .complete(identity, { ...largeResult, content: `${largeResult.content}!` })
            .pipe(Effect.flip)
          return { same, different: { reason: different.reason, message: different.message } }
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      expect(outcome).toEqual({
        same: largeResult,
        different: {
          reason: "conflict",
          message: "Tool execution already has a different result"
        }
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
    const contentOnly: ToolResult = { ...smallResult, content: "Long output.\n".repeat(3_000) }
    const objects = (rig: Rig) =>
      makeToolResultObjects(rig.outputs, { withLiveSession: (_, action) => action() })
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
              : { isError: entry.isError, retryable: entry.retryable, data: entry.data }
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
    // Without the objects, rows that left nothing out still read: they never open one.
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
            .historyResultMetadata({ sessionId: run.sessionId, toolCallIds: ["app"] })
            .pipe(Effect.flip)
          return { kept: [...kept.keys()].toSorted(), missing: missing.reason }
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      expect(outcome).toEqual({ kept: ["content", "small"], missing: "storage" })
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
                              arguments: JSON.stringify({ url: "https://example.com/start" })
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
                  makeToolResultObjects(rig.outputs, { withLiveSession: (_, action) => action() })
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

  it("slims stored rows in resumable chunks without changing what readers see", async () => {
    await withRig(async (rig) => {
      const readers = (run: {
        readonly sessionId: string
        readonly runId: string
        readonly turnId: string
      }) =>
        Effect.gen(function* () {
          const history = yield* ToolHistoryQueries
          const sessions = yield* SessionQueries
          const tools = yield* ToolExecutionStore
          const rows = yield* Effect.forEach(["large-1", "large-2", "large-3", "small"], (id) =>
            Effect.gen(function* () {
              const json = yield* storedRow(id)
              return {
                id,
                replayed: yield* replayed(identityOf(run, id)),
                fields: yield* Effect.forEach(sqlReadPaths(), (jsonPath) =>
                  jsonPath === "$.content" || jsonPath === "$.data"
                    ? Effect.succeed(null)
                    : extract(json, jsonPath)
                )
              }
            })
          )
          return {
            rows,
            ledger: yield* history.ledgerToolCall({
              sessionId: run.sessionId,
              toolCallId: "large-1",
              turnId: run.turnId
            }),
            prior: yield* tools.priorResults({ sessionId: run.sessionId, toolName: "web_fetch" }),
            evidence: yield* sessions.readToolEvidence({
              sessionId: run.sessionId,
              limit: 10,
              contentChars: 1_000_000
            })
          }
        })
      const legacy = await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* startRun
          for (const id of ["large-1", "large-2", "large-3"])
            yield* settle(identityOf(run, id), largeResult)
          yield* settle(identityOf(run, "small"), smallResult)
          return { run, readers: yield* readers(run), small: yield* storedRow("small") }
        }).pipe(Effect.provide(storage(rig, { slim: false })))
      )
      const chunk = (limit: number) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const queue = yield* PersistenceWriteQueue
          const writer = makeWriter({
            sql,
            reader: sql,
            queue,
            toolResults: () =>
              makeToolResultObjects(rig.outputs, { withLiveSession: (_, action) => action() })
          })
          const store = makeBackfillChunks({
            writer,
            reader: sql,
            sessionEvents: yield* SessionLifecycleEvents
          })
          return yield* store.runChunk(slimToolResultsBackfill, limit)
        })
      const steps = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          for (const name of ["script_execution_progress", "space_words"])
            yield* sql`INSERT INTO data_backfills (name, cursor, converted, started_at, updated_at, finished_at)
              VALUES (${name}, NULL, 0, '2026-11-13', '2026-11-13', '2026-11-13')
              ON CONFLICT(name) DO UPDATE SET finished_at = excluded.finished_at`
          return [yield* chunk(2)]
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      // A restart between chunks resumes from the saved cursor.
      const after = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          steps.push(yield* chunk(2))
          const slimRows = yield* sql<{ readonly n: number }>`
            SELECT count(*) AS n FROM tool_calls WHERE json_type(result_json, '$.stored_result') IS NOT NULL`
          yield* sql`UPDATE data_backfills SET cursor = NULL, finished_at = NULL
            WHERE name = 'slim_tool_results'`
          const again = yield* chunk(200)
          return {
            slimRows: slimRows[0]?.n,
            again: again.state,
            readers: yield* readers(legacy.run),
            small: yield* storedRow("small")
          }
        }).pipe(Effect.provide(storage(rig, { slim: true })))
      )
      expect(steps.map((step) => step.state)).toEqual([
        { name: "slim_tool_results", converted: 2, finished: false },
        { name: "slim_tool_results", converted: 3, finished: true }
      ])
      expect(after.slimRows).toBe(3)
      expect(after.again).toEqual({ name: "slim_tool_results", converted: 3, finished: true })
      expect(after.small).toBe(legacy.small)
      expect(after.readers).toEqual(legacy.readers)
      expect(await filesUnder(path.join(rig.outputs, "objects"))).toHaveLength(1)
    })
  })
})
