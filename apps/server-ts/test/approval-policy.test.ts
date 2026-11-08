import { defaultImpact } from "../src/execution/impact.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { ChatEventStore } from "../src/persistence/events/store.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { ApprovalPolicyStore } from "../src/persistence/permissions/approval-policy.js"
import { PermissionRules } from "../src/persistence/permissions/rules.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { scopedToolNames, toolRunsUnattended } from "../src/tools/tool-scopes.js"
import { makeToolApprovalPolicy, reachOf, toolRule } from "../src/tools/approval-policy.js"
import { toolFacts } from "../src/tools/approval-decision.js"
import { decide } from "../src/execution/decide.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { defineServerTool, type ServerTool } from "../src/tools/define.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { ToolHistoryQueries } from "../src/persistence/tools/history-queries.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { liveMode } from "./kit.js"
import { sqlitePersistenceLayer, withTempDatabase } from "./fixtures/temp-database.js"

const decided = Effect.fn("test.decided")(function* (
  approval: ReturnType<typeof makeToolApprovalPolicy>,
  runId: string,
  tool: ServerTool
) {
  const authority = yield* (yield* RunQueries).authority(runId)
  if (authority === undefined) return yield* Effect.die("no stored authority")
  const live = yield* approval.live({ runId, authority })
  return decide(
    authority,
    { state: live.state, mode: live.mode, rule: toolRule(live, tool.definition) },
    {
      tool: toolFacts(tool.definition),
      ...reachOf({ authority, live, tool, scopeNames: scopedToolNames([tool]) }),
      floor: undefined,
      target: undefined,
      requirement: false,
      user_only: false,
      reads_only: true,
      impact: defaultImpact(toolFacts(tool.definition)),
      approved: false
    }
  ).kind
})

const capturedPolicy = Effect.fn("test.capturedPolicy")(function* (runId: string) {
  return (yield* (yield* RunQueries).get(runId))?.metadata["run_policy"]
})

const report: ServerTool = defineServerTool({
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
    concurrency_group: null,
    destructive: false
  },
  execute: async () => ({ result: "published", preview: "published" })
})

const finishSpaceReview: ServerTool = defineServerTool({
  name: "space_review_finish",
  description: "Finish",
  parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
  metadata: {
    display_name: "Finish",
    kind: "tool",
    action: "write",
    source: "_runs",
    effect: "run_record",
    changes_state: false,
    default_approval: "approve",
    concurrency_group: null,
    destructive: false,
    internal_catalog: true,
    private_scope: "space"
  },
  execute: async () => ({ result: "finished", preview: "finished" })
})

it("keeps disposable Side chat runs and their agents free of approval requests", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const policy = yield* ApprovalPolicyStore
      const executions = yield* ToolExecutionStore
      const source = yield* sessions.create({ name: "Source" })
      const side = yield* sessions.branch(source.sessionId, { disposition: "disposable" })
      const retained = yield* sessions.branch(source.sessionId, {})
      if (side === undefined || retained === undefined) throw new Error("Missing branches")
      yield* sessions.completeBranchPreparation({ childSessionId: side.sessionId })
      yield* sessions.completeBranchPreparation({ childSessionId: retained.sessionId })
      const start = (sessionId: string, clientId: string) =>
        chat.start({
          sessionId,
          clientId,
          requestHash: clientId,
          assistantMessageId: `assistant:${clientId}`,
          approvalMode: "allow",
          message: {
            message_id: clientId,
            client_id: clientId,
            role: "user",
            content: "Work",
            created_at: "2026-10-16T00:00:00.000Z"
          }
        })
      const sideRun = yield* start(side.sessionId, "side-turn")
      const retainedRun = yield* start(retained.sessionId, "retained-turn")
      if (sideRun._tag !== "Started" || retainedRun._tag !== "Started")
        throw new Error("Missing runs")
      expect(yield* policy.session(side.sessionId)).toEqual({
        kind: "inherited",
        approval_mode: "ask"
      })
      expect(
        (yield* policy.setSession({ sessionId: side.sessionId, mode: "allow" }).pipe(Effect.result))
          ._tag
      ).toBe("Failure")
      const sideAuthority = yield* (yield* RunQueries).authority(sideRun.runId)
      const retainedAuthority = yield* (yield* RunQueries).authority(retainedRun.runId)
      if (sideAuthority === undefined || retainedAuthority === undefined)
        throw new Error("Missing authority")
      expect(
        (yield* policy.live({ runId: sideRun.runId, authority: sideAuthority })).noApproval
      ).toBe(true)
      expect(
        (yield* policy.live({ runId: retainedRun.runId, authority: retainedAuthority })).noApproval
      ).toBe(false)
      const spawn = {
        runId: sideRun.runId,
        sessionId: side.sessionId,
        toolCallId: "side-spawn",
        toolName: "spawn_agent",
        changesState: true,
        arguments: { task: "Work", mode: "research" }
      }
      yield* executions.begin(spawn)
      const { child } = yield* chat.spawnAgent({ parent: spawn, task: "Work", mode: "research" })
      const childAuthority = yield* (yield* RunQueries).authority(child.runId)
      if (childAuthority === undefined) throw new Error("Missing child authority")
      expect(
        (yield* policy.live({ runId: child.runId, authority: childAuthority })).noApproval
      ).toBe(true)
      expect(
        (yield* policy.live({
          runId: child.runId,
          authority: {
            ...childAuthority,
            approval: { follows: { kind: "chat", session_id: child.sessionId } }
          }
        })).noApproval
      ).toBe(true)
      const pending = {
        runId: sideRun.runId,
        sessionId: side.sessionId,
        toolCallId: "old-approval",
        toolName: "wiki_publish_report",
        changesState: true,
        arguments: {}
      }
      yield* executions.begin(pending)
      yield* executions.pause(pending, { reason: "Approval needed", preview: "Publish" })
      const unrelated = {
        ...pending,
        runId: retainedRun.runId,
        sessionId: retained.sessionId,
        toolCallId: "retained-approval"
      }
      yield* executions.begin(unrelated)
      yield* executions.pause(unrelated, { reason: "Approval needed", preview: "Publish" })
      const approved = yield* executions
        .resolve({ runId: sideRun.runId, toolCallId: pending.toolCallId, approved: true })
        .pipe(Effect.result)
      expect(approved._tag).toBe("Failure")
      if (approved._tag === "Failure") expect(approved.failure.reason).toBe("conflict")
      expect(yield* chat.sideRunsAwaitingApproval()).toEqual([sideRun.runId])
      yield* chat.cancel({ runId: sideRun.runId })
      expect(yield* chat.sideRunsAwaitingApproval()).toEqual([])
      const unrelatedDecision = yield* executions.resolve({
        runId: retainedRun.runId,
        toolCallId: unrelated.toolCallId,
        approved: true
      })
      expect(unrelatedDecision).toBeDefined()
    })
  )
})

it("persists chat approval choices without resolving existing prompts or changing captured access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-approval-policy-"))
  const persistence = () =>
    sqlitePersistenceLayer({ dataDir: null, filename: join(directory, "arden.db") }).pipe(
      Layer.provide(PersistenceWriteQueue.layer)
    )
  try {
    const seedLayer = persistence()
    const sessionId = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const chat = yield* ChatWriteStore
        const policy = yield* ApprovalPolicyStore
        const rules = yield* PermissionRules
        const executions = yield* ToolExecutionStore
        const toolHistory = yield* ToolHistoryQueries
        const session = yield* sessions.create({ name: "Permission test" })
        const run = yield* chat.start({
          sessionId: session.sessionId,
          clientId: "start",
          requestHash: "start",
          assistantMessageId: "assistant",
          message: {
            message_id: "start",
            client_id: "start",
            role: "user",
            content: "Publish",
            created_at: new Date().toISOString()
          }
        })
        const spawn = {
          runId: run.runId,
          sessionId: session.sessionId,
          toolCallId: "spawn",
          toolName: "spawn_agent",
          changesState: true,
          arguments: { task: "Check permissions", mode: "research" }
        }
        yield* executions.begin(spawn)
        const { child } = yield* chat.spawnAgent({
          parent: spawn,
          task: "Check permissions",
          mode: "research"
        })
        expect(yield* policy.session(child.sessionId)).toEqual({
          kind: "inherited",
          approval_mode: "safe"
        })
        const approval = makeToolApprovalPolicy({ policy, rules })
        const decisions = () => decided(approval, run.runId, report)
        expect(yield* decisions()).toBe("ask")
        expect(yield* decided(approval, run.runId, finishSpaceReview)).toBe("deny")
        const before = yield* capturedPolicy(run.runId)
        const identity = {
          runId: run.runId,
          sessionId: session.sessionId,
          toolCallId: "publish",
          toolName: "wiki_publish_report",
          changesState: true,
          arguments: {}
        }
        yield* executions.begin(identity)
        yield* executions.pause(identity, { reason: "approval", preview: "Publish" })
        yield* policy.setSession({ sessionId: session.sessionId, mode: "allow" })
        expect(yield* liveMode(run.runId)).toBe("allow")
        expect(yield* capturedPolicy(run.runId)).toEqual(before)
        expect(yield* liveMode(child.runId)).toBe("allow")
        expect(yield* policy.session(child.sessionId)).toEqual({
          kind: "inherited",
          approval_mode: "allow"
        })
        const off = yield* rules.save({
          subject: { kind: "tool", tool: "wiki_publish_report", server: null },
          list: { kind: "global" },
          decision: "never",
          source: { kind: "settings" }
        })
        expect(yield* decisions()).toBe("deny")
        expect(yield* toolHistory.pendingApprovals(session.sessionId)).toHaveLength(1)
        yield* rules.change({ ruleId: off.id, decision: "remove", source: { kind: "settings" } })
        expect(yield* toolHistory.pendingApprovals(session.sessionId)).toHaveLength(1)
        yield* policy.setSession({ sessionId: session.sessionId, mode: "ask" })
        expect(yield* decisions()).toBe("ask")
        expect(yield* policy.session(child.sessionId)).toEqual({
          kind: "inherited",
          approval_mode: "ask"
        })
        yield* policy.setSession({ sessionId: session.sessionId, mode: "allow" })
        return session.sessionId
      }).pipe(Effect.provide(seedLayer))
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const policy = yield* ApprovalPolicyStore
        expect(yield* policy.session(sessionId)).toEqual({
          kind: "chat",
          approval_mode: "allow"
        })
        yield* policy.setSession({ sessionId, mode: "ask" })
        expect(yield* policy.session(sessionId)).toEqual({
          kind: "chat",
          approval_mode: "ask"
        })
      }).pipe(Effect.provide(persistence()))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("escalates nested agent approvals to the parent Chat and resolves them there", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-agent-approval-escalation-"))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatWriteStore
        const sessions = yield* SessionStore
        const tools = yield* ToolExecutionStore
        const toolHistory = yield* ToolHistoryQueries
        const events = yield* ChatEventStore
        const parent = yield* sessions.create({ name: "Main agent" })
        const run = yield* chat.start({
          sessionId: parent.sessionId,
          clientId: "start",
          requestHash: "start",
          assistantMessageId: "assistant",
          message: {
            message_id: "start",
            client_id: "start",
            role: "user",
            content: "Delegate",
            created_at: new Date().toISOString()
          }
        })
        const spawn = {
          runId: run.runId,
          sessionId: parent.sessionId,
          toolCallId: "spawn-child",
          toolName: "spawn_agent",
          changesState: true,
          arguments: { task: "Review", mode: "research" }
        }
        yield* tools.begin(spawn)
        const { child } = yield* chat.spawnAgent({
          parent: spawn,
          task: "Review",
          mode: "research"
        })
        const nestedSpawn = {
          runId: child.runId,
          sessionId: child.sessionId,
          toolCallId: "spawn-grandchild",
          toolName: "spawn_agent",
          changesState: true,
          arguments: { task: "Check", mode: "research" }
        }
        yield* tools.begin(nestedSpawn)
        const { child: grandchild } = yield* chat.spawnAgent({
          parent: nestedSpawn,
          task: "Check",
          mode: "research"
        })
        const held = {
          runId: grandchild.runId,
          sessionId: grandchild.sessionId,
          toolCallId: "held-write",
          toolName: "file_write",
          changesState: true,
          arguments: { path: "notes.md", content: "Findings" }
        }
        yield* tools.begin(held)
        yield* tools.pause(held, { reason: "approval", preview: "Create notes.md" })
        expect(
          (yield* toolHistory.pendingDescendantApprovals(parent.sessionId)).map((approval) => ({
            runId: approval.run_id,
            sessionId: approval.session_id,
            toolId: approval.tool_id
          }))
        ).toEqual([
          { runId: grandchild.runId, sessionId: grandchild.sessionId, toolId: held.toolCallId }
        ])
        const before = yield* events.readPage({
          sessionId: parent.sessionId,
          afterSequence: 0,
          throughSequence: 100,
          limit: 100
        })
        expect(before.records.map((record) => record.event)).toContainEqual(
          expect.objectContaining({
            type: "approval_needed",
            run_id: grandchild.runId,
            session_id: grandchild.sessionId,
            tool_id: held.toolCallId
          })
        )
        yield* tools.resolve({
          runId: grandchild.runId,
          toolCallId: held.toolCallId,
          approved: true
        })
        expect(
          yield* tools.resolve({
            runId: grandchild.runId,
            toolCallId: held.toolCallId,
            approved: true
          })
        ).toEqual({ runId: grandchild.runId, ready: true })
        expect(
          (yield* tools
            .resolve({
              runId: grandchild.runId,
              toolCallId: held.toolCallId,
              approved: false
            })
            .pipe(Effect.result))._tag
        ).toBe("Failure")
        expect(yield* toolHistory.pendingDescendantApprovals(parent.sessionId)).toEqual([])
        const after = yield* events.readPage({
          sessionId: parent.sessionId,
          afterSequence: 0,
          throughSequence: 100,
          limit: 100
        })
        expect(after.records.map((record) => record.event)).toContainEqual(
          expect.objectContaining({
            type: "approval_resolved",
            run_id: grandchild.runId,
            tool_id: held.toolCallId,
            approved: true
          })
        )
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
        const space = yield* spaces.create({ name: "Revoked toolset" })
        const session = yield* sessions.create({ name: "Task source", spaceId: space.space_id })
        const parent = yield* chat.start({
          sessionId: session.sessionId,
          clientId: "request",
          requestHash: "request",
          assistantMessageId: "assistant",
          message: {
            message_id: "request",
            client_id: "request",
            role: "user",
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

it("uses its chat's editable mode for an automation and its running descendants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-automation-permission-"))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const automations = yield* AutomationCatalog
        const queue = yield* AutomationQueue
        const chat = yield* ChatWriteStore
        const policy = yield* ApprovalPolicyStore
        const rules = yield* PermissionRules
        const automation = yield* automations.create(
          {
            history: "chat",
            name: "Reports",
            prompt: "Publish reports",
            triggers: [{ type: "time", every: "1h" }],
            approval_mode: "ask",
            idempotency_key: "b944bba4-4700-463e-a4be-13a467d0b20b",
            idempotency_scope: "global"
          },
          "owner"
        )
        yield* queue.requestRun(AutomationId.make(automation.task_id))
        const [lease] = yield* Effect.promise(async () =>
          queue.jobs.claim({ workerId: "test", now: Date.now(), limit: 1, leaseDurationMs: 30000 })
        )
        if (!lease || !lease.payload.sessionId) throw new Error("Expected automation lease")
        const run = yield* chat.start({
          sessionId: lease.payload.sessionId,
          clientId: "automation",
          requestHash: "automation",
          assistantMessageId: "assistant",
          automationLease: { id: lease.id, token: lease.token },
          automation: {
            automationId: lease.payload.automationId,
            name: lease.payload.name,
            attemptId: lease.payload.automationRunId
          },
          automationContextMode: "continue",
          automationPrompt: "Publish",
          message: {
            message_id: "automation",
            client_id: "automation",
            role: "user",
            content: "Publish",
            automation: {
              context_mode: "continue",
              task_id: lease.payload.automationId,
              name: lease.payload.name,
              prompt: "Publish"
            },
            created_at: new Date().toISOString()
          }
        })
        if (automation.chat === null) throw new Error("Expected the automation's chat")
        const executionId = automation.chat.session_id
        if (run._tag !== "Started") return yield* Effect.die("The automation run did not start")
        const before = yield* capturedPolicy(run.runId)
        const approval = makeToolApprovalPolicy({ policy, rules })
        const decisions = () => decided(approval, run.runId, report)
        expect(yield* decisions()).toBe("ask")
        expect(yield* policy.session(executionId)).toEqual({
          kind: "chat",
          approval_mode: "ask"
        })
        yield* policy.setSession({ sessionId: executionId, mode: "allow" })
        expect(yield* liveMode(run.runId)).toBe("allow")
        expect(yield* decisions()).toBe("allow")
        yield* policy.setSession({ sessionId: executionId, mode: "read_only" })
        expect(yield* liveMode(run.runId)).toBe("read_only")
        expect(yield* decisions()).toBe("deny")
        expect(yield* capturedPolicy(run.runId)).toEqual(before)
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
