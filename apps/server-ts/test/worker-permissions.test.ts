import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { McpStore } from "../src/persistence/mcp/store.js"
import { PermissionRules } from "../src/persistence/permissions/rules.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { ToolHistoryQueries } from "../src/persistence/tools/history-queries.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { present } from "./kit.js"
import { dailySummaryHandler } from "../src/automations/handlers/daily-summary.js"

it.each(["space", "automation", "system"] as const)(
  "a card's Always allow in a %s run saves to the run's own list: its Space's, Arden's own jobs', else everywhere",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "arden-worker-permissions-"))
    const layer = () =>
      recoveredSqlitePersistenceLayer({
        dataDir: null,
        filename: join(directory, "arden.db")
      }).pipe(Layer.provide(PersistenceWriteQueue.layer))
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const chat = yield* ChatWriteStore
          const sessions = yield* SessionStore
          const spaces = yield* SpaceStore
          const automations = yield* AutomationCatalog
          const queue = yield* AutomationQueue
          const mcp = yield* McpStore
          const tools = yield* ToolExecutionStore
          const toolHistory = yield* ToolHistoryQueries
          yield* mcp.create({
            name: "fixture",
            enabled: true,
            presetId: null,
            transport: {
              type: "http",
              url: "https://fixture.invalid/mcp",
              auth: "none",
              headerKeys: []
            }
          })
          const space = yield* spaces.create({ name: "Permission owner" })
          const userAutomation = {
            history: "chat",
            name: "Permission owner",
            prompt: "Review",
            triggers: [{ type: "time", every: "1h" }],
            approval_mode: "allow",
            idempotency_key: "c2cc49d0-5aa7-4c54-b922-e85c37759bdd",
            idempotency_scope: "global"
          } as const
          const automation = yield* Effect.gen(function* () {
            switch (kind) {
              case "space":
                return undefined
              case "automation":
                return yield* automations.create(userAutomation, "owner")
              case "system":
                yield* automations.seedSystemAutomations([dailySummaryHandler.spec])
                return yield* automations.get(dailySummaryHandler.spec.automationId)
            }
          })
          if (automation != null) yield* queue.requestRun(AutomationId.make(automation.task_id))
          const lease =
            automation != null
              ? (yield* Effect.promise(async () =>
                  queue.jobs.claim({
                    workerId: "test",
                    now: Date.now(),
                    limit: 1,
                    leaseDurationMs: 30_000
                  })
                ))[0]
              : undefined
          const sessionId =
            lease?.payload.sessionId ??
            (yield* sessions.create({ name: "Request", spaceId: space.space_id })).sessionId
          const parent = yield* chat.start({
            sessionId,
            clientId: "request",
            requestHash: "request",
            assistantMessageId: "answer",
            ...(lease
              ? {
                  automationLease: { id: lease.id, token: lease.token },
                  automation: {
                    automationId: lease.payload.automationId,
                    name: lease.payload.name,
                    attemptId: lease.payload.automationRunId
                  },
                  automationContextMode: "continue",
                  automationPrompt: "Review"
                }
              : {}),
            message: {
              message_id: "request",
              client_id: "request",
              role: "user",
              content: "Review",
              created_at: new Date().toISOString(),
              ...(lease
                ? {
                    automation: {
                      context_mode: "continue",
                      task_id: lease.payload.automationId,
                      name: lease.payload.name,
                      prompt: "Review"
                    }
                  }
                : {})
            }
          })
          const spawn = {
            runId: parent.runId,
            sessionId,
            toolCallId: "spawn",
            toolName: "spawn_agent",
            changesState: true,
            arguments: { task: "Review", mode: "work" }
          }
          yield* tools.begin(spawn)
          const { child } = yield* chat.spawnAgent({ parent: spawn, task: "Review", mode: "work" })
          const call = {
            runId: child.runId,
            sessionId: child.sessionId,
            toolCallId: "read",
            toolName: "mcp__fixture__read",
            source: "mcp:fixture",
            changesState: false,
            arguments: {}
          }
          yield* tools.begin(call)
          yield* tools.pause(call, { reason: "approval", detail: "Read the connected source" })
          const pending = (yield* toolHistory.pendingApprovals(child.sessionId))[0]
          const rules = yield* PermissionRules
          const saved = Effect.gen(function* () {
            return (yield* rules.list()).map(({ subject, list, decision, source }) => ({
              subject,
              list,
              decision,
              source
            }))
          })
          if (kind === "system") {
            expect(pending?.rule_places).toEqual([{ kind: "system" }, { kind: "everywhere" }])
            yield* tools.resolve({
              runId: child.runId,
              toolCallId: "read",
              approved: true,
              grantStanding: true
            })
            expect(yield* saved).toEqual([
              {
                subject: { kind: "tool", tool: call.toolName, server: "fixture" },
                list: { kind: "system" },
                decision: "allow",
                source: { kind: "card", runId: child.runId }
              }
            ])
            return
          }
          if (automation != null) {
            expect(pending?.rule_places).toEqual([{ kind: "everywhere" }])
            yield* tools.resolve({
              runId: child.runId,
              toolCallId: "read",
              approved: true,
              grantStanding: true
            })
            expect(yield* saved).toEqual([
              {
                subject: { kind: "tool", tool: call.toolName, server: "fixture" },
                list: { kind: "global" },
                decision: "allow",
                source: { kind: "card", runId: child.runId }
              }
            ])
            return
          }
          expect(pending?.rule_places).toEqual([
            { kind: "space", name: "Permission owner" },
            { kind: "everywhere" }
          ])
          yield* tools.resolve({
            runId: child.runId,
            toolCallId: "read",
            approved: true,
            grantStanding: true
          })
          expect(yield* saved).toEqual([
            {
              subject: { kind: "tool", tool: call.toolName, server: "fixture" },
              list: { kind: "space", spaceId: space.space_id },
              decision: "allow",
              source: { kind: "card", runId: child.runId }
            }
          ])
          const grants = yield* rules.list()
          expect(grants).toMatchObject([
            { list: { kind: "space", spaceId: space.space_id }, subject: { tool: call.toolName } }
          ])
          yield* rules.change({
            ruleId: present(grants[0], "grants[0]").id,
            decision: "remove",
            source: { kind: "settings" }
          })
          expect(yield* rules.list()).toEqual([])
          const everywhere = { ...call, toolCallId: "read-everywhere" }
          yield* tools.begin(everywhere)
          yield* tools.pause(everywhere, {
            reason: "approval",
            detail: "Read the connected source"
          })
          yield* tools.resolve({
            runId: child.runId,
            toolCallId: "read-everywhere",
            approved: true,
            grantStanding: true,
            grantList: "global"
          })
          expect(yield* saved).toEqual([
            {
              subject: { kind: "tool", tool: call.toolName, server: "fixture" },
              list: { kind: "global" },
              decision: "allow",
              source: { kind: "card", runId: child.runId }
            }
          ])
          yield* rules.change({
            ruleId: present((yield* rules.list())[0], "global rule").id,
            decision: "remove",
            source: { kind: "settings" }
          })
          const raced = { ...call, toolCallId: "read-raced" }
          yield* tools.begin(raced)
          yield* tools.pause(raced, { reason: "approval", detail: "Read the connected source" })
          const ownerAsk = yield* rules.save({
            subject: { kind: "tool", tool: call.toolName, server: "fixture" },
            list: { kind: "global" },
            decision: "ask",
            source: { kind: "settings" }
          })
          yield* tools.resolve({
            runId: child.runId,
            toolCallId: "read-raced",
            approved: true,
            grantStanding: true
          })
          expect(yield* saved).toEqual([
            {
              subject: { kind: "tool", tool: call.toolName, server: "fixture" },
              list: { kind: "global" },
              decision: "ask",
              source: { kind: "settings", runId: null }
            }
          ])
          expect(
            (yield* toolHistory.pendingApprovals(child.sessionId)).some(
              (approval) => approval.tool_id === "read-raced"
            )
          ).toBe(false)
          yield* rules.change({
            ruleId: ownerAsk.id,
            decision: "remove",
            source: { kind: "settings" }
          })
          yield* rules.save({
            subject: { kind: "tool", tool: call.toolName, server: "fixture" },
            list: { kind: "space", spaceId: space.space_id },
            decision: "ask",
            source: { kind: "settings" }
          })
          const asked = { ...call, toolCallId: "read-again" }
          yield* tools.begin(asked)
          yield* tools.pause(asked, { reason: "approval", detail: "Read the connected source" })
          const again = (yield* toolHistory.pendingApprovals(child.sessionId)).find(
            (approval) => approval.tool_id === "read-again"
          )
          expect(again?.rule_places).toEqual([{ kind: "everywhere" }])
        }).pipe(Effect.provide(layer()))
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
