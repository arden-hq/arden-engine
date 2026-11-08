import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  authorityScopes,
  deriveAuthority,
  narrow,
  takesAnswersMidRun,
  type AdmissionFacts,
  type RunAuthority
} from "../src/execution/authority.js"
import {
  boundary,
  decide,
  refusalPath,
  type CallFacts,
  type Decision,
  type LiveSettings
} from "../src/execution/decide.js"
import type { RunPolicy } from "../src/execution/policy.js"
import { toolFacts } from "../src/tools/approval-decision.js"
import { CONTAINED, defaultImpact, INERT, OUTWARD } from "../src/execution/impact.js"
import { defineServerTool, type ServerTool } from "../src/tools/define.js"

const policy: RunPolicy = {
  budget_id: "budget",
  budget_generation: 0,
  execution: { mode: "inline", observe: false },
  capabilities: ["all"],
  auto_approve: false,
  google_accounts: null,
  space: {
    space_id: "space-a",
    generation: 1,
    inference: { enabled: false }
  }
}

const admitted = (overrides: Partial<AdmissionFacts>): RunAuthority =>
  deriveAuthority({
    sessionId: "chat-1",
    context: { origin: { kind: "chat", session_id: "chat-1", turn_id: "t1" }, task: null },
    policy,
    originAutomation: null,
    chatAutomation: null,
    ...overrides
  })

const person = admitted({})
const personInAutomationChat = admitted({
  chatAutomation: {
    automation_id: "auto-1",
    purpose: "user_automation",
    handler: null,
    owner_space_id: null
  }
})
const automation = admitted({
  context: {
    origin: { kind: "automation", automation_id: "auto-1", occurrence_id: "o1" },
    task: null
  },
  originAutomation: {
    automation_id: "auto-1",
    purpose: "user_automation",
    handler: null,
    owner_space_id: null
  }
})
const automationInOwnChat = admitted({
  context: {
    origin: { kind: "automation", automation_id: "auto-1", occurrence_id: "o1" },
    task: null
  },
  originAutomation: {
    automation_id: "auto-1",
    purpose: "user_automation",
    handler: null,
    owner_space_id: null
  },
  policy: { ...policy, space: null }
})
const taskWorker = admitted({
  context: {
    origin: { kind: "task", item_id: "task-1", occurrence_id: "o1" },
    task: { item_id: "task-1", generation: 1 }
  }
})
const spaceReview = admitted({
  context: { origin: { kind: "space", space_id: "space-a", occurrence_id: "o1" }, task: null }
})
const delegateOf = (parent: RunAuthority): RunAuthority => {
  const child = narrow(parent, {
    mode: "research",
    sessionId: "agent-chat",
    parentRunId: "parent-run",
    workspaceRoot: null,
    taskItemId: null
  })
  if (child.kind !== "narrowed") throw new Error("expected a delegate")
  return child.authority
}

const tool = (
  name: string,
  metadata: {
    readonly action: "read" | "write"
    readonly effect?: "none" | "run_record" | "arden_db"
    readonly default_approval?: "approve" | "ask"
    readonly self_gated?: boolean
    readonly always_ask?: boolean
    readonly approval_bypass?: boolean
    readonly refuse_unattended?: boolean
    readonly requirement?: "boundary"
  },
  perCall = false
): ServerTool =>
  defineServerTool({
    name,
    description: name,
    parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
    metadata: {
      display_name: name,
      kind: "tool",
      action: metadata.action,
      source: "_test",
      effect: metadata.effect ?? (metadata.action === "read" ? "none" : "arden_db"),
      changes_state: metadata.action === "write",
      ...(metadata.action === "write" ? { target: "reported" as const } : {}),
      default_approval: metadata.default_approval ?? "approve",
      concurrency_group: null,
      destructive: false,
      ...(metadata.self_gated === true ? { read_only_mode: "self_gated" as const } : {}),
      ...(metadata.always_ask === true ? { always_ask: true } : {}),
      ...(metadata.approval_bypass === true ? { approval_bypass: true } : {}),
      ...(metadata.refuse_unattended === true ? { refuse_unattended: true } : {}),
      ...(metadata.requirement === undefined ? {} : { requirement: metadata.requirement })
    },
    ...(perCall ? { approvalRequirement: async () => undefined } : {}),
    ...(metadata.always_ask === true ? { approvalPrompt: async () => ({ preview: name }) } : {}),
    execute: async () => "done"
  })

const live = (overrides: Partial<LiveSettings> = {}): LiveSettings => ({
  state: "active",
  mode: "ask",
  rule: undefined,
  ...overrides
})

const call = (target: ServerTool, overrides: Partial<CallFacts> = {}): CallFacts => ({
  tool: toolFacts(target.definition),
  impact: defaultImpact(toolFacts(target.definition)),
  available: true,
  unattended_scope: false,
  floor: undefined,
  target: undefined,
  requirement: false,
  user_only: false,
  reads_only: true,
  approved: false,
  ...overrides
})

const verdict = (decision: Decision) => {
  switch (decision.kind) {
    case "allow":
      return { allow: decision.by }
    case "ask":
      return { ask: decision.reason, ...decision.presentation }
    case "deny":
      return { deny: decision.rule, instead: decision.instead.map((path) => path.kind) }
  }
}

const write = tool("space_task_update", { action: "write" })
const outcome = tool("run_no_change", { action: "write", effect: "run_record" })
const archive = tool("space_archive", { action: "write", always_ask: true })
const shell = tool("exec_command", { action: "write", self_gated: true }, true)
const typing = tool(
  "write_stdin",
  { action: "write", self_gated: true, refuse_unattended: true },
  true
)

const send = tool(
  "session_send_message",
  { action: "write", default_approval: "ask", requirement: "boundary" },
  true
)
const crossSpace = (handed: boolean) =>
  ({ kind: "chat", verb: "message", other_space: true, handed }) as const

describe("decide: one row per case", () => {
  it("decides each recorded case the way the rules say", () => {
    const rows = {
      "settling: its own record": verdict(
        decide(taskWorker, live({ state: "settling" }), call(outcome))
      ),
      "settling: any other write": verdict(
        decide(taskWorker, live({ state: "settling" }), call(write))
      ),
      revoked: verdict(decide(taskWorker, live({ state: "revoked" }), call(outcome))),
      "read_only: its own record": verdict(
        decide(taskWorker, live({ mode: "read_only" }), call(outcome))
      ),
      "read_only: a write": verdict(decide(taskWorker, live({ mode: "read_only" }), call(write))),
      "space_archive in allow": verdict(decide(person, live({ mode: "allow" }), call(archive))),
      "space_archive in safe": verdict(decide(person, live({ mode: "safe" }), call(archive))),
      "destructive command in allow": verdict(
        decide(person, live({ mode: "allow" }), call(shell, { floor: "destructive_command" }))
      ),
      "user deny beats allow": verdict(
        decide(person, live({ mode: "allow", rule: "never" }), call(write))
      ),
      "user ask beats allow": verdict(
        decide(person, live({ mode: "allow", rule: "ask" }), call(write))
      ),
      "allow rule, a write in read_only": verdict(
        decide(person, live({ mode: "read_only", rule: "allow" }), call(write))
      ),
      "allow rule, host command not allowed": verdict(
        decide(person, live({ rule: "allow" }), call(shell, { requirement: true }))
      ),
      "allow rule, host ask, Never ask": verdict(
        decide(
          person,
          live({ mode: "allow", rule: "allow" }),
          call(shell, { requirement: true, user_only: true })
        )
      ),
      "host command in safe, person": verdict(
        decide(person, live({ mode: "safe" }), call(shell, { requirement: true }))
      ),
      "host command, always ask, safe": verdict(
        decide(person, live({ mode: "safe" }), call(shell, { requirement: true, user_only: true }))
      ),
      "host command, always ask, allow": verdict(
        decide(person, live({ mode: "allow" }), call(shell, { requirement: true, user_only: true }))
      ),
      "host command in safe, Automation": verdict(
        decide(automation, live({ mode: "safe" }), call(shell, { requirement: true }))
      ),
      "host command in ask, Automation": verdict(
        decide(automation, live({ mode: "ask" }), call(shell, { requirement: true }))
      ),
      "Auto ask in an Automation": verdict(
        decide(automation, live({ mode: "safe" }), call(write, { requirement: true }))
      ),
      "Ask mode default ask in an Automation": verdict(
        decide(automation, live({ mode: "ask" }), call(send))
      ),
      "rule ask in a Never ask Automation": verdict(
        decide(automation, live({ mode: "allow", rule: "ask" }), call(write))
      ),
      "typed input in ask, Automation": verdict(
        decide(automation, live({ mode: "ask" }), call(typing, { requirement: true }))
      ),
      "typed input in safe, Automation": verdict(
        decide(automation, live({ mode: "safe" }), call(typing, { requirement: true }))
      ),
      "typed input rule ask, Automation": verdict(
        decide(automation, live({ rule: "ask" }), call(typing))
      ),
      "typed input in ask, person": verdict(
        decide(person, live({ mode: "ask" }), call(typing, { requirement: true }))
      ),
      "host command in ask, agent of a chat": verdict(
        decide(delegateOf(person), live({ mode: "ask" }), call(shell, { requirement: true }))
      ),
      "host command in safe, agent of a chat": verdict(
        decide(delegateOf(person), live({ mode: "safe" }), call(shell, { requirement: true }))
      ),
      "typed input in ask, agent of a chat": verdict(
        decide(delegateOf(person), live({ mode: "ask" }), call(typing, { requirement: true }))
      ),
      "sandboxed command in safe": verdict(
        decide(delegateOf(person), live({ mode: "safe" }), call(shell, { requirement: false }))
      ),
      "host command in allow, setting off": verdict(
        decide(automation, live({ mode: "allow" }), call(shell, { requirement: false }))
      ),
      "approved on its card": verdict(
        decide(person, live(), call(shell, { requirement: true, approved: true }))
      ),
      "Automation out of reach": verdict(
        decide(automation, live(), call(write, { available: false }))
      ),
      "agent out of reach": verdict(
        decide(delegateOf(person), live(), call(write, { available: false }))
      ),
      "agent of a Space chat, other Space": verdict(
        decide(
          delegateOf(person),
          live(),
          call(write, {
            target: {
              kind: "space_work",
              requested_space_id: "space-b",
              chat_space_id: "space-a",
              op: "change"
            }
          })
        )
      ),
      "person messages another Space, Auto": verdict(
        decide(
          person,
          live({ mode: "safe" }),
          call(write, {
            target: { kind: "chat", verb: "message", other_space: true, handed: false }
          })
        )
      ),
      "person messages another Space, Never ask": verdict(
        decide(
          person,
          live({ mode: "allow" }),
          call(write, {
            target: { kind: "chat", verb: "message", other_space: true, handed: false }
          })
        )
      ),
      "person messages another Space, Never ask, tool set to ask": verdict(
        decide(
          person,
          live({ mode: "allow", rule: "ask" }),
          call(write, {
            target: { kind: "chat", verb: "message", other_space: true, handed: false }
          })
        )
      ),
      "person sends on this Space, Auto": verdict(
        decide(person, live({ mode: "safe" }), call(send))
      ),
      "person sends on this Space, Auto, always allowed": verdict(
        decide(person, live({ mode: "safe", rule: "allow" }), call(send))
      ),
      "person sends to another Space, Auto, always allowed": verdict(
        decide(
          person,
          live({ mode: "safe", rule: "allow" }),
          call(send, { target: crossSpace(false), requirement: true, user_only: true })
        )
      ),
      "person forwards a handed capture to another Space, Ask": verdict(
        decide(person, live(), call(write, { target: crossSpace(true) }))
      ),
      "agent forwards a handed capture to another Space": verdict(
        decide(delegateOf(person), live(), call(write, { target: crossSpace(true) }))
      ),
      "Automation messages another Space": verdict(
        decide(
          automation,
          live(),
          call(write, {
            target: { kind: "chat", verb: "message", other_space: true, handed: false }
          })
        )
      )
    }
    expect(rows).toEqual({
      "settling: its own record": { allow: "rule" },
      "settling: any other write": { deny: "settling", instead: [] },
      revoked: { deny: "revoked", instead: [] },
      "read_only: its own record": { allow: "rule" },
      "read_only: a write": {
        deny: "read_only",
        instead: ["tool", "ask_user", "report"]
      },
      "space_archive in allow": { ask: "always_ask", helper: false, delivery: "pause" },
      "space_archive in safe": { ask: "always_ask", helper: false, delivery: "pause" },
      "destructive command in allow": { deny: "floor", instead: ["ask_user"] },
      "user deny beats allow": { deny: "user_deny", instead: ["ask_user"] },
      "user ask beats allow": { ask: "override", helper: false, delivery: "pause" },
      "allow rule, a write in read_only": { deny: "read_only", instead: ["ask_user"] },
      "allow rule, host command not allowed": {
        ask: "requirement",
        helper: false,
        delivery: "pause"
      },
      "allow rule, host ask, Never ask": { ask: "requirement", helper: false, delivery: "pause" },
      "host command in safe, person": { ask: "requirement", helper: true, delivery: "pause" },
      "host command, always ask, safe": { ask: "requirement", helper: false, delivery: "pause" },
      "host command, always ask, allow": { ask: "requirement", helper: false, delivery: "pause" },
      "host command in safe, Automation": { ask: "requirement", helper: true, delivery: "chat" },
      "host command in ask, Automation": { ask: "requirement", helper: false, delivery: "chat" },
      "Auto ask in an Automation": { ask: "requirement", helper: true, delivery: "chat" },
      "Ask mode default ask in an Automation": { ask: "default", helper: false, delivery: "chat" },
      "rule ask in a Never ask Automation": { ask: "override", helper: false, delivery: "chat" },
      "typed input in ask, Automation": { ask: "requirement", helper: false, delivery: "refuse" },
      "typed input in safe, Automation": { ask: "requirement", helper: true, delivery: "refuse" },
      "typed input rule ask, Automation": { ask: "override", helper: false, delivery: "refuse" },
      "typed input in ask, person": { ask: "requirement", helper: false, delivery: "pause" },
      "host command in ask, agent of a chat": {
        ask: "requirement",
        helper: false,
        delivery: "chat"
      },
      "host command in safe, agent of a chat": {
        ask: "requirement",
        helper: true,
        delivery: "chat"
      },
      "typed input in ask, agent of a chat": {
        ask: "requirement",
        helper: false,
        delivery: "pause"
      },
      "sandboxed command in safe": { allow: "mode" },
      "host command in allow, setting off": { allow: "mode" },
      "approved on its card": { allow: "user" },
      "Automation out of reach": { deny: "reach", instead: ["ask_user", "report"] },
      "agent out of reach": { deny: "reach", instead: ["report"] },
      "agent of a Space chat, other Space": { deny: "boundary", instead: ["report"] },
      "person messages another Space, Auto": { ask: "boundary", helper: false, delivery: "pause" },
      "person messages another Space, Never ask": { allow: "mode" },
      "person messages another Space, Never ask, tool set to ask": {
        ask: "override",
        helper: false,
        delivery: "pause"
      },
      "person sends on this Space, Auto": { ask: "default", helper: true, delivery: "pause" },
      "person sends on this Space, Auto, always allowed": { allow: "grant" },
      "person sends to another Space, Auto, always allowed": {
        ask: "boundary",
        helper: false,
        delivery: "pause"
      },
      "person forwards a handed capture to another Space, Ask": { allow: "default" },
      "agent forwards a handed capture to another Space": { deny: "boundary", instead: ["report"] },
      "Automation messages another Space": { allow: "default" }
    })
  })

  it("keeps the boundary rules", () => {
    const work = (requested: string | undefined, op: "create" | "change") =>
      ({ kind: "space_work", requested_space_id: requested, chat_space_id: "space-a", op }) as const
    expect({
      "person in Automation chat, other Space": boundary(
        personInAutomationChat,
        work("space-b", "change")
      ),
      "person in Automation chat holds no worker scope":
        authorityScopes(personInAutomationChat).includes("worker"),
      "Task worker, own Space": boundary(taskWorker, work(undefined, "change")),
      "Task worker hands off a Task": boundary(taskWorker, work("space-b", "create")),
      "Task worker changes another Space": boundary(taskWorker, work("space-b", "change")),
      "Task worker's agent stays a job": boundary(
        delegateOf(taskWorker),
        work(undefined, "change")
      ),
      "Automation in its own chat changes a named Space": boundary(automationInOwnChat, {
        kind: "space_work",
        requested_space_id: "space-b",
        chat_space_id: undefined,
        op: "change"
      }),
      "agent of a loose chat creates on a named Space": boundary(
        delegateOf(admitted({ policy: { ...policy, space: null } })),
        {
          kind: "space_work",
          requested_space_id: "space-b",
          chat_space_id: undefined,
          op: "create"
        }
      ),
      "person browses all Spaces": boundary(person, { kind: "chat_browse", scope: "all_spaces" }),
      "Automation browses all Spaces": boundary(automation, {
        kind: "chat_browse",
        scope: "all_spaces"
      }),
      "Space review browses all Spaces": boundary(spaceReview, {
        kind: "chat_browse",
        scope: "all_spaces"
      }),
      "Task worker browses all Spaces": boundary(taskWorker, {
        kind: "chat_browse",
        scope: "all_spaces"
      }),
      "Automation changes Space settings": boundary(automation, { kind: "space_control" }),
      "person opens a chat on another Space": boundary(person, {
        kind: "chat",
        verb: "open",
        other_space: true,
        handed: false
      }),
      "Automation opens a chat on another Space": boundary(automation, {
        kind: "chat",
        verb: "open",
        other_space: true,
        handed: false
      }),
      "agent of a chat sets directives": boundary(delegateOf(person), { kind: "directives" })
    }).toEqual({
      "person in Automation chat, other Space": { kind: "allow", reach: "full" },
      "person in Automation chat holds no worker scope": false,
      "Task worker, own Space": { kind: "allow", reach: "job" },
      "Task worker hands off a Task": {
        kind: "deny",
        instead: [{ kind: "tool", name: "task_comment" }, { kind: "ask_user" }, { kind: "report" }]
      },
      "Task worker changes another Space": {
        kind: "deny",
        instead: [{ kind: "tool", name: "task_comment" }, { kind: "ask_user" }, { kind: "report" }]
      },
      "Task worker's agent stays a job": { kind: "allow", reach: "job" },
      "Automation in its own chat changes a named Space": { kind: "allow", reach: "full" },
      "agent of a loose chat creates on a named Space": {
        kind: "deny",
        instead: [{ kind: "report" }]
      },
      "person browses all Spaces": { kind: "allow", reach: undefined },
      "Automation browses all Spaces": { kind: "allow", reach: undefined },
      "Space review browses all Spaces": { kind: "allow", reach: undefined },
      "Task worker browses all Spaces": {
        kind: "deny",
        instead: [{ kind: "tool", name: "session_read" }]
      },
      "Automation changes Space settings": { kind: "allow", reach: undefined },
      "person opens a chat on another Space": { kind: "allow", reach: undefined },
      "Automation opens a chat on another Space": {
        kind: "deny",
        instead: [{ kind: "ask_user" }, { kind: "report" }]
      },
      "agent of a chat sets directives": { kind: "deny", instead: [{ kind: "ask_user" }] }
    })
    expect(
      (
        [
          [person, false],
          [automation, false],
          [delegateOf(automation), true],
          [delegateOf(person), false]
        ] as const
      ).map(([each, agentChat]) => takesAnswersMidRun(each.actor, agentChat))
    ).toEqual([true, false, true, false])
    expect(refusalPath(automation.actor).map((path) => path.kind)).not.toContain("tool")
  })
})

describe("your Automation acts as you", () => {
  const standing = (kind: "always" | "requirement", overrides: Partial<CallFacts> = {}) => {
    const base = call(write, overrides)
    return { ...base, tool: { ...base.tool, standing: kind } }
  }

  it("has your reach, and only a standing change asks it in every mode", () => {
    expect({
      "Automation holds no worker scope": authorityScopes(automation).includes("worker"),
      "its agent still does": authorityScopes(delegateOf(automation)).includes("worker"),
      "Automation starts a Task": boundary(automation, {
        kind: "space_work",
        requested_space_id: undefined,
        chat_space_id: "space-a",
        op: "create"
      }),
      "directives, Never ask": verdict(
        decide(automation, live({ mode: "allow" }), standing("always"))
      ),
      "directives, Auto": verdict(decide(automation, live({ mode: "safe" }), standing("always"))),
      "the person's own directives, Never ask": verdict(
        decide(person, live({ mode: "allow" }), standing("always"))
      ),
      "Space settings that widen permissions, Never ask": verdict(
        decide(automation, live({ mode: "allow" }), standing("requirement", { requirement: true }))
      ),
      "Space settings that do not, Never ask": verdict(
        decide(automation, live({ mode: "allow" }), standing("requirement"))
      ),
      "a Task write, Never ask": verdict(decide(automation, live({ mode: "allow" }), call(write)))
    }).toEqual({
      "Automation holds no worker scope": false,
      "its agent still does": true,
      "Automation starts a Task": { kind: "allow", reach: "full" },
      "directives, Never ask": { ask: "standing", helper: false, delivery: "chat" },
      "directives, Auto": { ask: "standing", helper: false, delivery: "chat" },
      "the person's own directives, Never ask": { allow: "mode" },
      "Space settings that widen permissions, Never ask": {
        ask: "standing",
        helper: false,
        delivery: "chat"
      },
      "Space settings that do not, Never ask": { allow: "mode" },
      "a Task write, Never ask": { allow: "mode" }
    })
  })
})

describe("the locked list (plan, Appendix B decision 3)", () => {
  const act = tool("browser_act", { action: "write", refuse_unattended: true }, true)
  const password = (overrides: Partial<CallFacts> = {}) =>
    call(act, { impact: { kind: "locked", category: "passwords" }, ...overrides })
  const connector = tool("mcp__bank__transfer", { action: "write", default_approval: "ask" })

  it("asks the owner above every rule, mode and Helper; only a never or the floor refuses", () => {
    expect({
      "an allow rule, Auto": verdict(
        decide(person, live({ mode: "safe", rule: "allow" }), password())
      ),
      "Never ask": verdict(decide(person, live({ mode: "allow" }), password())),
      "its own card in Auto, not the owner's alone": verdict(
        decide(person, live({ mode: "safe" }), password({ requirement: true }))
      ),
      "a read in Read only": verdict(
        decide(
          person,
          live({ mode: "read_only" }),
          call(tool("read", { action: "read" }), {
            impact: { kind: "locked", category: "passwords" }
          })
        )
      ),
      "a write in Read only": verdict(decide(person, live({ mode: "read_only" }), password())),
      "unattended, can wait": verdict(
        decide(
          automation,
          live({ mode: "allow" }),
          call(write, { impact: { kind: "locked", category: "move_money" } })
        )
      ),
      "unattended, cannot wait": verdict(decide(automation, live({ mode: "safe" }), password())),
      "approved on its card": verdict(
        decide(person, live({ mode: "ask" }), password({ approved: true }))
      ),
      "a never rule": verdict(decide(person, live({ mode: "allow", rule: "never" }), password())),
      "a destructive command": verdict(
        decide(person, live({ mode: "allow" }), password({ floor: "destructive_command" }))
      ),
      "the same tool, no password": verdict(
        decide(person, live({ mode: "safe", rule: "allow" }), call(act))
      ),
      "a connector tool with no category, Never ask": verdict(
        decide(person, live({ mode: "allow" }), call(connector))
      ),
      "a connector tool with no category, Auto": verdict(
        decide(person, live({ mode: "safe" }), call(connector))
      )
    }).toEqual({
      "an allow rule, Auto": { ask: "locked", helper: false, delivery: "pause" },
      "Never ask": { ask: "locked", helper: false, delivery: "pause" },
      "its own card in Auto, not the owner's alone": {
        ask: "locked",
        helper: false,
        delivery: "pause"
      },
      "a read in Read only": { ask: "locked", helper: false, delivery: "pause" },
      "a write in Read only": { deny: "read_only", instead: ["ask_user"] },
      "unattended, can wait": { ask: "locked", helper: false, delivery: "chat" },
      "unattended, cannot wait": { ask: "locked", helper: false, delivery: "refuse" },
      "approved on its card": { allow: "user" },
      "a never rule": { deny: "user_deny", instead: ["ask_user"] },
      "a destructive command": { deny: "floor", instead: ["ask_user"] },
      "the same tool, no password": { allow: "grant" },
      "a connector tool with no category, Never ask": { allow: "mode" },
      "a connector tool with no category, Auto": { ask: "default", helper: true, delivery: "pause" }
    })
  })
})

describe("code settles a call by its impact; only an outward one reaches the reviewer", () => {
  const act = tool("browser_act", { action: "write", default_approval: "ask" })
  const at = (mode: LiveSettings["mode"], impact: CallFacts["impact"], overrides = {}) =>
    verdict(decide(person, live({ mode, ...overrides }), call(act, { impact })))

  it("decides each impact in each mode", () => {
    expect({
      "inert, Ask every time": at("ask", INERT),
      "inert, Auto": at("safe", INERT),
      "inert, Never ask": at("allow", INERT),
      "inert, Read only": at("read_only", INERT),
      "contained, Ask every time": at("ask", CONTAINED),
      "contained, Auto": at("safe", CONTAINED),
      "contained, Never ask": at("allow", CONTAINED),
      "outward, Ask every time": at("ask", OUTWARD),
      "outward, Auto": at("safe", OUTWARD),
      "outward, Never ask": at("allow", OUTWARD),
      "outward, Auto, an allow rule": at("safe", OUTWARD, { rule: "allow" })
    }).toEqual({
      "inert, Ask every time": { allow: "mode" },
      "inert, Auto": { allow: "mode" },
      "inert, Never ask": { allow: "mode" },
      "inert, Read only": { deny: "read_only", instead: ["ask_user"] },
      "contained, Ask every time": { ask: "default", helper: false, delivery: "pause" },
      "contained, Auto": { allow: "mode" },
      "contained, Never ask": { allow: "mode" },
      "outward, Ask every time": { ask: "default", helper: false, delivery: "pause" },
      "outward, Auto": { ask: "default", helper: true, delivery: "pause" },
      "outward, Never ask": { allow: "mode" },
      "outward, Auto, an allow rule": { allow: "grant" }
    })
  })

  it("never lets an inert or contained call skip a floor, a rule's ask or its own requirement", () => {
    const shellCall = (impact: CallFacts["impact"], overrides: Partial<CallFacts>) =>
      verdict(decide(person, live({ mode: "safe" }), call(shell, { impact, ...overrides })))
    expect({
      "inert, a destructive command": shellCall(INERT, { floor: "destructive_command" }),
      "contained, its own card": shellCall(CONTAINED, { requirement: true }),
      "inert, the owner's own card": shellCall(INERT, { requirement: true, user_only: true }),
      "inert, a rule's ask": at("safe", INERT, { rule: "ask" }),
      "inert, a rule's never": at("allow", INERT, { rule: "never" }),
      "inert, an always-ask tool": verdict(
        decide(person, live({ mode: "allow" }), call(archive, { impact: INERT }))
      )
    }).toEqual({
      "inert, a destructive command": { deny: "floor", instead: ["ask_user"] },
      "contained, its own card": { ask: "requirement", helper: true, delivery: "pause" },
      "inert, the owner's own card": { ask: "requirement", helper: false, delivery: "pause" },
      "inert, a rule's ask": { ask: "override", helper: true, delivery: "pause" },
      "inert, a rule's never": { deny: "user_deny", instead: ["ask_user"] },
      "inert, an always-ask tool": { ask: "always_ask", helper: false, delivery: "pause" }
    })
  })
})
