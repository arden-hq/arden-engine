import { ROLE } from "@arden-hq/std/message-vocabulary"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { ApprovalPolicyStore } from "../src/persistence/permissions/approval-policy.js"
import { PermissionRules } from "../src/persistence/permissions/rules.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { toolRunsUnattended } from "../src/tools/tool-scopes.js"
import { makeToolApprovalPolicy } from "../src/tools/approval-policy.js"
import { defineServerTool, type ServerTool } from "../src/tools/define.js"
import { liveMode } from "./kit.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"
import { decided, report } from "./approval-policy-kit.js"

it("refuses every tool call after a Task attempt loses authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-revoked-toolset-"))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatWriteStore
        const spaces = yield* SpaceStore
        const sessions = yield* SessionStore
        const executions = yield* ToolExecutionStore
        const work = yield* WorkStore
        const policy = yield* ApprovalPolicyStore
        const rules = yield* PermissionRules
        const space = yield* spaces.create({
          name: "Revoked toolset",
          instructions: { kind: "unwritten" }
        })
        const session = yield* sessions.create({ name: "Task source", spaceId: space.space_id })
        const parent = yield* chat.start({
          sessionId: session.sessionId,
          clientId: "request",
          requestHash: "request",
          assistantMessageId: "assistant",
          message: {
            message_id: "request",
            client_id: "request",
            role: ROLE.user,
            content: "Track the review",
            created_at: "2026-09-17T00:00:00.000Z"
          }
        })
        if (parent._tag !== "Started") return yield* Effect.die("Parent did not start")
        const task = yield* work.createFromChat({
          scope: { kind: "space", spaceId: space.space_id },
          sessionId: session.sessionId,
          runId: parent.runId,
          input: { key: "review", text: "Review the evidence" },
          capture: { basis: "explicit", reason: "The user requested the review." }
        })
        const spawn = {
          runId: parent.runId,
          sessionId: session.sessionId,
          toolCallId: "spawn",
          toolName: "spawn_agent",
          changesState: true,
          arguments: { task: task.text, mode: "work", task_item_id: task.item_id }
        }
        yield* executions.begin(spawn)
        const { child } = yield* chat.spawnAgent({
          parent: spawn,
          task: task.text,
          mode: "work",
          taskItemId: task.item_id
        })
        const approval = makeToolApprovalPolicy({ policy, rules })
        expect(yield* liveMode(child.runId)).not.toBe("settling")
        yield* work.update(
          { kind: "key", scope: { kind: "space", spaceId: space.space_id }, key: task.stable_key },
          task.updated_at,
          { status: "cancelled" },
          child.runId
        )
        expect(yield* liveMode(child.runId)).toBe("settling")
        expect(yield* decided(approval, child.runId, report)).toBe("deny")
        yield* chat.admitModelRequest(child.runId, "final-response")
        expect(yield* work.revokedRuns()).toEqual([])
      }).pipe(
        Effect.provide(
          sqlitePersistenceLayer({ dataDir: null, filename: join(directory, "arden.db") }).pipe(
            Layer.provide(PersistenceWriteQueue.layer)
          )
        )
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("a run with every capability publishes its own report unattended; a narrower one does not", () => {
  const unattended: ServerTool = defineServerTool({
    name: "wiki_publish_report",
    description: "Publish",
    parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
    metadata: {
      display_name: "Publish",
      kind: "tool",
      action: "write",
      source: "_wiki",
      effect: "arden_db",
      changes_state: true,
      target: "reported",
      default_approval: "ask",
      scopes: ["reports"],
      unattended_scope: "reports",
      concurrency_group: null,
      destructive: false
    },
    execute: async () => ({ result: "published", preview: "published" })
  })
  expect(toolRunsUnattended(unattended, ["reports"])).toBe(true)
  expect(toolRunsUnattended(unattended, ["all"])).toBe(true)
  expect(toolRunsUnattended(unattended, ["read_only"])).toBe(false)
})
