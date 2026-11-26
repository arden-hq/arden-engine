import { ROLE } from "@arden-hq/std/message-vocabulary"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createToolset, PauseRequested } from "@arden-hq/loop"
import { Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { readRunRules } from "../src/execution/rules.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { PermissionRules } from "../src/persistence/permissions/rules.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { ToolHistoryQueries } from "../src/persistence/tools/history-queries.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { makeApprovalGate } from "../src/tools/approval-gate.js"
import { defineServerTool, type ServerTool } from "../src/tools/define.js"
import { makeMacAppsTools } from "../src/tools/mac-apps.js"
import { makeFakeMacHelper, type FakeMacHelper } from "./fixtures/fake-mac-helper.js"
import { gatePolicy, present, runAuthority, serverRunContext } from "./kit.js"

const REMINDER = { id: "REM-1", title: "Renew passport", list: "Errands", completed: false }
const LISTS = [{ id: "LIST-1", title: "Errands", writable: true, default: true }]

let fake: FakeMacHelper

beforeAll(async () => {
  fake = await makeFakeMacHelper()
  await fake.answer({
    "reminders lists": { prints: LISTS },
    "reminders get": { prints: REMINDER },
    "reminders create": { prints: REMINDER },
    "reminders delete": { prints: { deleted: "REM-1", title: "Renew passport" } }
  })
})

afterAll(() => fake.remove())

const Args = Schema.Struct({ outside: Schema.optionalKey(Schema.Boolean) })
const card = { preview: "Change it", presentation: { title: "Change it?", fields: [] } }
const metadata = {
  display_name: "Change",
  kind: "tool",
  action: "write",
  source: "_test",
  effect: "arden_db",
  changes_state: true,
  target: "reported",
  concurrency_group: null,
  destructive: false,
  default_approval: "ask"
} as const
const change = (name: string, extra: Partial<Parameters<typeof defineServerTool>[0]>): ServerTool =>
  defineServerTool({
    name,
    description: "Change something",
    parameters: Schema.toStandardSchemaV1(Args),
    metadata,
    approvalPrompt: () => card,
    execute: async () => "changed",
    ...extra
  })

/** What the gate did with one call: ran it, or paused on a card and which rule the card may save. */
const outcome = async (attempt: Promise<{ readonly content: string }>) => {
  const settled = await attempt.then(
    (result) => ({ ran: result.content }),
    (cause: unknown) => cause
  )
  if (settled instanceof PauseRequested) return { asked: settled.data?.["tool_grant"] ?? null }
  if (settled instanceof Error) throw settled
  return settled
}

describe("Always allow on a built-in tool's card", () => {
  it("is offered only when an Allow rule would have let the call run", async () => {
    const toolset = (mode: "ask" | "allow", overrides = {}) =>
      createToolset(
        [
          change("plain", {}),
          change("removes", { metadata: { ...metadata, destructive: true } }),
          change("always", { metadata: { ...metadata, always_ask: true } }),
          change("guarded", {
            approvalRequirement: (input: typeof Args.Type) =>
              input.outside === true ? card : undefined
          }),
          change("on_site", { site: () => "https://example.com" })
        ],
        {
          toJsonSchema: () => ({ type: "object" }),
          approvalGate: makeApprovalGate({
            review: async () => ({ verdict: "ask", why: { kind: "failed" } }),
            policy: gatePolicy(mode, { overrides })
          })
        }
      )(serverRunContext())
    const ask = (name: string, args = {}, overrides = {}) =>
      outcome(toolset("ask", overrides).execute({ name, args, toolCallId: name }))
    const tool = (name: string) => ({ subject: { kind: "tool", tool: name, server: null } })
    expect(await ask("plain")).toEqual({ asked: tool("plain") })
    // The owner's own Ask rule can be replaced where it does not hold; the store decides where.
    expect(await ask("plain", {}, { plain: "ask" })).toEqual({ asked: tool("plain") })
    expect(await ask("removes")).toEqual({ asked: null })
    expect(await ask("always")).toEqual({ asked: null })
    expect(await ask("guarded")).toEqual({ asked: tool("guarded") })
    expect(await ask("guarded", { outside: true })).toEqual({ asked: null })
    expect(await ask("on_site")).toEqual({
      asked: { subject: { kind: "site", tool: "on_site", origin: "https://example.com" } }
    })
    expect(await ask("plain", {}, { plain: "approve" })).toEqual({ ran: "changed" })
  })

  it("saves a rule for a Mac reminder in the Space or everywhere, then asks only for the delete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-builtin-card-rule-"))
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
          const tools = yield* ToolExecutionStore
          const history = yield* ToolHistoryQueries
          const rules = yield* PermissionRules
          const space = yield* spaces.create({ name: "Home", instructions: { kind: "unwritten" } })
          const { sessionId } = yield* sessions.create({ name: "Request", spaceId: space.space_id })
          const { runId } = yield* chat.start({
            sessionId,
            clientId: "request",
            requestHash: "request",
            assistantMessageId: "answer",
            message: {
              message_id: "request",
              client_id: "request",
              role: ROLE.user,
              content: "Remind me",
              created_at: new Date().toISOString()
            }
          })
          const base = runAuthority()
          const authority = runAuthority({
            actor: { kind: "person", session_id: sessionId, turn_id: "turn" },
            owns: { ...base.owns, session_id: sessionId, space_id: space.space_id },
            approval: { follows: { kind: "chat", session_id: sessionId } }
          })
          const policy = gatePolicy("ask")
          const toolset = createToolset(makeMacAppsTools({ path: fake.path, platform: "darwin" }), {
            toJsonSchema: () => ({ type: "object" }),
            approvalGate: makeApprovalGate({
              review: async () => ({ verdict: "ask", why: { kind: "failed" } }),
              policy: {
                ...policy,
                live: async () => ({
                  ...(await policy.live(serverRunContext())),
                  rules: await Effect.runPromise(readRunRules(rules, authority))
                })
              }
            })
          })(serverRunContext({ runId, sessionId, authority }))
          /** One call through the gate; a card is stored as the server stores it. */
          const call = (toolName: string, args: Record<string, unknown>, toolCallId: string) =>
            Effect.gen(function* () {
              const identity = {
                runId,
                sessionId,
                toolCallId,
                toolName,
                source: "_mac_apps",
                changesState: true,
                arguments: args
              }
              yield* tools.begin(identity)
              const settled = yield* Effect.promise(() =>
                toolset.execute({ name: toolName, args, toolCallId }).then(
                  (result) => result,
                  (cause: unknown) => cause
                )
              )
              if (!(settled instanceof PauseRequested)) {
                if (settled instanceof Error) return yield* Effect.die(settled)
                yield* tools.complete(identity, settled)
                return { ran: settled.content.split("\n")[0] }
              }
              yield* tools.pause(identity, {
                reason: "approval",
                ...(settled.detail === undefined ? {} : { detail: settled.detail }),
                ...(settled.data === undefined ? {} : { data: settled.data })
              })
              const pending = (yield* history.pendingApprovals(sessionId)).find(
                (approval) => approval.tool_id === toolCallId
              )
              return { places: present(pending, "pending approval").rule_places }
            })
          /** The owner's answer; an approved call then runs to its end, as the server runs it. */
          const answer = (
            toolName: string,
            args: Record<string, unknown>,
            toolCallId: string,
            decision: { readonly approved: boolean; readonly grantList?: "global" }
          ) =>
            Effect.gen(function* () {
              yield* tools.resolve({
                runId,
                toolCallId,
                approved: decision.approved,
                ...(decision.approved ? { grantStanding: true } : {}),
                ...(decision.grantList === undefined ? {} : { grantList: decision.grantList })
              })
              if (!decision.approved) return
              const identity = {
                runId,
                sessionId,
                toolCallId,
                toolName,
                source: "_mac_apps",
                changesState: true,
                arguments: args
              }
              yield* tools.begin(identity)
              yield* tools.complete(identity, { content: "done", preview: "done" })
            })
          const saved = rules
            .list()
            .pipe(
              Effect.map((all) =>
                all.map(({ subject, list, source }) => ({ subject, list, source }))
              )
            )
          const create = { title: "Renew passport" }
          const subject = { kind: "tool", tool: "mac_reminders_create", server: null }

          expect(yield* call("mac_reminders_create", create, "create-1")).toEqual({
            places: [{ kind: "space", name: "Home" }, { kind: "everywhere" }]
          })
          yield* answer("mac_reminders_create", create, "create-1", { approved: true })
          expect(yield* saved).toEqual([
            {
              subject,
              list: { kind: "space", spaceId: space.space_id },
              source: { kind: "card", runId }
            }
          ])
          expect(yield* call("mac_reminders_create", create, "create-2")).toEqual({
            ran: "Added the reminder: Renew passport"
          })
          expect(
            yield* call("mac_reminders_delete", { reminder_ref: "REM-1" }, "delete-1")
          ).toEqual({
            places: []
          })
          yield* answer("mac_reminders_delete", { reminder_ref: "REM-1" }, "delete-1", {
            approved: false
          })

          yield* rules.change({
            ruleId: present((yield* rules.list())[0], "the card's rule").id,
            decision: "remove",
            source: { kind: "settings" }
          })
          expect(yield* call("mac_reminders_create", create, "create-3")).toEqual({
            places: [{ kind: "space", name: "Home" }, { kind: "everywhere" }]
          })
          yield* answer("mac_reminders_create", create, "create-3", {
            approved: true,
            grantList: "global"
          })
          expect(yield* saved).toEqual([
            { subject, list: { kind: "global" }, source: { kind: "card", runId } }
          ])
          expect(yield* call("mac_reminders_create", create, "create-4")).toEqual({
            ran: "Added the reminder: Renew passport"
          })
        }).pipe(Effect.provide(layer))
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
