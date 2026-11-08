import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createToolset } from "@arden-hq/loop"
import type { JsonValue } from "@arden-hq/protocol"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"
import { makeApprovalGate } from "../src/tools/approval-gate.js"
import { makeApprovalEditor, type ServerApprovalEdits } from "../src/tools/approval-edits.js"
import { CREATE_APPROVAL_EDITS, createChatWhere } from "../src/tools/automation-create-card.js"
import { CreateParametersSchema } from "../src/tools/automation-tool-schema.js"
import { defineServerTool, type ServerTool } from "../src/tools/define.js"
import { gatePolicy, serverRunContext } from "./kit.js"

const unused = (): never => {
  throw new Error("not used by this test")
}

const run = serverRunContext({
  sessionId: "session-1",
  runId: "run-1",
  policy: {
    budget_id: "run-1",
    budget_generation: 0,
    execution: { mode: "worker", observe: false },
    capabilities: ["all"],
    auto_approve: false,
    google_accounts: null,
    space: null
  },
  approvalMode: "ask",
  codeMode: {
    call: unused,
    changesState: () => false,
    describe: () => undefined,
    scriptFields: () => undefined
  },
  scriptHost: {
    executionProfile: {
      hash: "unused",
      modes: { research: { changesState: false }, code: { changesState: true } }
    },
    agent: unused,
    tool: unused,
    changesState: () => false
  }
})

const ReminderArgs = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  lead: Schema.Int,
  room: Schema.optionalKey(Schema.String),
  secret: Schema.optionalKey(Schema.String)
})

const metadata = {
  display_name: "Reminder",
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

const ran: Array<unknown> = []

const reminderEdits: ServerApprovalEdits<typeof ReminderArgs.Type> = {
  fields: ["name", "lead", "room"],
  check: (input) => (input.lead > 240 ? "At most 4 hours before" : undefined),
  describe: (requested, edited) =>
    requested.lead === edited.lead
      ? []
      : [
          {
            field: "lead",
            label: "When",
            from: `${requested.lead} min before`,
            to: `${edited.lead} min before`
          }
        ]
}

const reminder = (edits: boolean): ServerTool =>
  defineServerTool({
    name: "reminder",
    description: "Create a reminder",
    parameters: Schema.toStandardSchemaV1(ReminderArgs),
    metadata,
    ...(edits ? { approvalEdits: reminderEdits } : {}),
    execute: async (input: typeof ReminderArgs.Type) => {
      ran.push(input)
      return { result: `Created ${input.name}`, preview: "Created", data: { name: input.name } }
    }
  })

const toolsetWith = (tool: ServerTool) =>
  createToolset([tool], {
    toJsonSchema: () => ({ type: "object" }),
    approvals: () => ({ reminder: "ask" }),
    approvalGate: makeApprovalGate({
      review: async () => ({ verdict: "ask", why: { kind: "failed" } }),
      policy: gatePolicy("ask")
    })
  })(run)

const requested = { name: "Call briefs", lead: 120 }

describe("approval edits", () => {
  it("runs an approved call with the user's arguments and tells the model what changed", async () => {
    ran.length = 0
    const result = await toolsetWith(reminder(true)).execute({
      name: "reminder",
      args: requested,
      toolCallId: "1",
      approval: {
        approved: true,
        feedback: null,
        edited: { requested, arguments: { name: "Call briefs", lead: 60, room: "own" } }
      }
    })
    expect(ran).toEqual([{ name: "Call briefs", lead: 60, room: "own" }])
    expect(result.content).toContain(
      "\n- When: 120 min before → 60 min before\n\nCreated Call briefs"
    )
    expect(result.data).toEqual({
      name: "Call briefs",
      approval_edits: [
        { field: "lead", label: "When", from: "120 min before", to: "60 min before" }
      ],
      approval: { by: "user", decision: "approved", edited: true }
    })
  })

  it("leaves an unedited approval exactly as before", async () => {
    ran.length = 0
    const result = await toolsetWith(reminder(true)).execute({
      name: "reminder",
      args: requested,
      toolCallId: "2",
      approval: { approved: true, feedback: null }
    })
    expect(ran).toEqual([requested])
    expect(result.content).toBe("Created Call briefs")
    expect(result.data).toEqual({
      name: "Call briefs",
      approval: { by: "user", decision: "approved" }
    })
  })

  it("refuses edits a tool did not opt into, or to fields its card cannot change", async () => {
    ran.length = 0
    await expect(
      toolsetWith(reminder(false)).execute({
        name: "reminder",
        args: requested,
        toolCallId: "3",
        approval: {
          approved: true,
          feedback: null,
          edited: { requested, arguments: { ...requested, lead: 30 } }
        }
      })
    ).rejects.toThrow("This tool takes no edits on its approval card")
    await expect(
      toolsetWith(reminder(true)).execute({
        name: "reminder",
        args: requested,
        toolCallId: "4",
        approval: {
          approved: true,
          feedback: null,
          edited: { requested, arguments: { ...requested, secret: "x" } }
        }
      })
    ).rejects.toThrow("The card cannot change secret")
    expect(ran).toEqual([])
  })

  it("checks edits by the tool's schema and rules before they are recorded", () => {
    const editor = reminder(true).approvalEditor
    if (editor === undefined) throw new Error("the reminder takes edits")
    expect(editor.apply(requested, { name: "Call briefs", lead: 60 })).toEqual({
      _tag: "Edited",
      arguments: { name: "Call briefs", lead: 60 }
    })
    expect(editor.apply({ ...requested, room: "space" }, requested)).toEqual({
      _tag: "Edited",
      arguments: requested
    })
    expect(editor.apply(requested, { lead: 120, name: "Call briefs" })).toEqual({
      _tag: "Unchanged"
    })
    expect(editor.apply(requested, { name: "", lead: 60 })._tag).toBe("Refused")
    expect(editor.apply(requested, { name: "Call briefs", lead: 600 })).toEqual({
      _tag: "Refused",
      reason: "At most 4 hours before"
    })
    expect(editor.apply(requested, { ...requested, secret: "x" })._tag).toBe("Refused")
  })

  it("checks an edited When of any trigger kind by automation_create's own rules", () => {
    const editor = makeApprovalEditor(
      Schema.toStandardSchemaV1(CreateParametersSchema, {
        parseOptions: { onExcessProperty: "error" }
      }),
      CREATE_APPROVAL_EDITS
    )
    const asked = {
      name: "Inbox sweep",
      prompt: "Sweep the inbox",
      history: "fresh",
      triggers: [{ type: "time", at: "09:00", days: "weekdays" }]
    }
    const when = (triggers: ReadonlyArray<JsonValue>) => ({
      name: asked.name,
      prompt: asked.prompt,
      triggers
    })
    for (const triggers of [
      [{ type: "time", every: "2h", start: "09:00", end: "18:00" }],
      [{ type: "time", at: "07:30", on: "2026-11-02" }],
      [{ type: "idle", idle_minutes: 30 }],
      [{ type: "count", every_n: 5 }],
      [
        { type: "time", at: "09:00", days: "daily" },
        { type: "time", at: "17:00", days: "daily" }
      ]
    ]) {
      expect(editor.apply(asked, when(triggers))._tag).toBe("Edited")
    }
    for (const triggers of [
      [{ type: "time", every: "2h", start: "18:00", end: "09:00" }],
      [{ type: "time", at: "09:00", every: "1h" }],
      [{ type: "time", at: "25:00" }],
      [{ type: "time", at: "09:00", days: "someday" }],
      [
        { type: "idle", idle_minutes: 10 },
        { type: "idle", idle_minutes: 20 }
      ]
    ]) {
      expect(editor.apply(asked, when(triggers))._tag).toBe("Refused")
    }
  })

  it("records edits only with an approval and replays them when the call resumes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-approval-edits-"))
    const layer = sqlitePersistenceLayer({
      dataDir: null,
      filename: join(directory, "arden.db")
    }).pipe(Layer.provide(PersistenceWriteQueue.layer))
    const editor = reminder(true).approvalEditor
    if (editor === undefined) throw new Error("the reminder takes edits")
    const apply = (call: {
      readonly toolName: string
      readonly requested: Readonly<Record<string, Schema.Json>>
      readonly patch: Readonly<Record<string, Schema.Json>>
    }) => editor.apply(call.requested, call.patch)
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionStore
          const chat = yield* ChatWriteStore
          const tools = yield* ToolExecutionStore
          const session = yield* sessions.create({ name: "Edits" })
          const started = yield* chat.start({
            sessionId: session.sessionId,
            clientId: "start",
            requestHash: "start",
            assistantMessageId: "assistant",
            message: {
              message_id: "start",
              client_id: "start",
              role: "user",
              content: "Remind me before calls",
              created_at: new Date().toISOString()
            }
          })
          const call = (toolCallId: string) => ({
            runId: started.runId,
            sessionId: session.sessionId,
            toolCallId,
            toolName: "reminder",
            changesState: false,
            arguments: requested
          })
          yield* tools.begin(call("edited"))
          yield* tools.pause(call("edited"), { reason: "approval", preview: "Create" })
          yield* tools.begin(call("plain"))
          yield* tools.pause(call("plain"), { reason: "approval", preview: "Create" })

          const refused = yield* tools
            .resolve({
              runId: started.runId,
              toolCallId: "edited",
              approved: true,
              edits: { patch: { name: "Call briefs", lead: 600 }, apply }
            })
            .pipe(Effect.flip)
          expect(refused.reason).toBe("invalid")
          const rejected = yield* tools
            .resolve({
              runId: started.runId,
              toolCallId: "edited",
              approved: false,
              edits: { patch: { name: "Call briefs", lead: 60 }, apply }
            })
            .pipe(Effect.flip)
          expect(rejected.reason).toBe("invalid")

          yield* tools.resolve({
            runId: started.runId,
            toolCallId: "edited",
            approved: true,
            edits: { patch: { name: "Call briefs", lead: 60 }, apply }
          })
          yield* tools.resolve({ runId: started.runId, toolCallId: "plain", approved: true })

          const edited = yield* tools.begin(call("edited"))
          const plain = yield* tools.begin(call("plain"))
          expect(edited).toEqual({
            _tag: "Started",
            approval: {
              approved: true,
              feedback: null,
              edited: { requested, arguments: { name: "Call briefs", lead: 60 } }
            }
          })
          expect(plain).toEqual({ _tag: "Started", approval: { approved: true, feedback: null } })
        }).pipe(Effect.provide(layer))
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
