import { ROLE } from "@arden-hq/std/message-vocabulary"
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
import { dailySummaryHandler } from "../src/automations/handlers/daily-summary.js"
import { newAutomation, everyTrigger } from "./fixtures/automation-input.js"

type Kind = "space" | "automation" | "system"

const inRun = async (
  kind: Kind,
  body: (scene: {
    readonly tools: ToolExecutionStore["Service"]
    readonly rules: PermissionRules["Service"]
    readonly toolHistory: ToolHistoryQueries["Service"]
    readonly child: { readonly runId: string; readonly sessionId: string }
    readonly spaceId: string
    readonly pause: (toolCallId: string) => Effect.Effect<void, unknown>
  }) => Effect.Effect<void, unknown>
) => {
  const directory = await mkdtemp(join(tmpdir(), "arden-worker-permissions-"))
  const layer = recoveredSqlitePersistenceLayer({
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
        const space = yield* spaces.create({
          name: "Permission owner",
          instructions: { kind: "unwritten" }
        })
        const userAutomation = newAutomation({
          history: "chat",
          name: "Permission owner",
          prompt: "Review",
          triggers: [everyTrigger("1h")],
          approval_mode: "allow",
          idempotency_key: "c2cc49d0-5aa7-4c54-b922-e85c37759bdd"
        })
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
            content: "Review",
            created_at: new Date().toISOString(),
            ...(lease
              ? {
                  role: ROLE.interaction,
                  kind: "assignment",
                  from: {
                    source: "automation",
                    id: lease.payload.automationId,
                    name: lease.payload.name
                  },
                  automation: {
                    context_mode: "continue",
                    task_id: lease.payload.automationId,
                    name: lease.payload.name,
                    prompt: "Review"
                  }
                }
              : { role: ROLE.user })
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
        const rules = yield* PermissionRules
        const pause = (toolCallId: string) =>
          Effect.gen(function* () {
            const call = {
              runId: child.runId,
              sessionId: child.sessionId,
              toolCallId,
              toolName: "mcp__fixture__read",
              source: "mcp:fixture",
              changesState: false,
              arguments: {}
            }
            yield* tools.begin(call)
            yield* tools.pause(call, { reason: "approval", detail: "Read the connected source" })
          })
        yield* body({ tools, rules, toolHistory, child, spaceId: space.space_id, pause })
      }).pipe(Effect.provide(layer))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const places = {
  space: [{ kind: "space", name: "Permission owner" }, { kind: "everywhere" }],
  automation: [{ kind: "everywhere" }],
  system: [{ kind: "system" }, { kind: "everywhere" }]
} as const

it.each(["space", "automation", "system"] as const)(
  "a card's Always allow in a %s run saves to the run's own list: its Space's, Arden's own jobs', else everywhere",
  async (kind) => {
    await inRun(kind, (scene) =>
      Effect.gen(function* () {
        yield* scene.pause("read")
        const pending = (yield* scene.toolHistory.pendingApprovals(scene.child.sessionId))[0]
        expect(pending?.rule_places).toEqual(places[kind])
        yield* scene.tools.resolve({
          runId: scene.child.runId,
          toolCallId: "read",
          approved: true,
          grantStanding: true
        })
        const saved = yield* scene.rules.list()
        const list = {
          space: { kind: "space", spaceId: scene.spaceId },
          automation: { kind: "global" },
          system: { kind: "system" }
        }[kind]
        expect(saved).toMatchObject([
          {
            subject: { kind: "tool", tool: "mcp__fixture__read", server: "fixture" },
            list,
            decision: "allow"
          }
        ])
      })
    )
  }
)

it("an owner's ask rule made while a card waits is not replaced by Always allow", async () => {
  await inRun("space", (scene) =>
    Effect.gen(function* () {
      yield* scene.pause("read")
      yield* scene.rules.save({
        subject: { kind: "tool", tool: "mcp__fixture__read", server: "fixture" },
        list: { kind: "global" },
        decision: "ask",
        source: { kind: "settings" }
      })
      yield* scene.tools.resolve({
        runId: scene.child.runId,
        toolCallId: "read",
        approved: true,
        grantStanding: true
      })
      expect(yield* scene.rules.list()).toMatchObject([
        { list: { kind: "global" }, decision: "ask" }
      ])
    })
  )
})
