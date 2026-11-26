import { describe, expect, it } from "vitest"
import {
  authorityScopes,
  takesAnswersMidRun,
  type RunAuthority
} from "../src/execution/authority.js"
import { narrow } from "../src/execution/delegation.js"
import { boundary, decide, refusalPath, type CallFacts } from "../src/execution/decide.js"
import {
  admitted,
  automation,
  call,
  live,
  person,
  policy,
  tool,
  verdict,
  write
} from "./authority-decide-kit.js"

const personInAutomationChat = admitted({
  chatOwner: { kind: "automation", key: "auto-1", purpose: "user_automation", handler: null }
})
const automationInOwnChat = admitted({
  context: {
    origin: { kind: "automation", automation_id: "auto-1", occurrence_id: "o1" },
    task: null
  },
  originOwner: { kind: "automation", key: "auto-1", purpose: "user_automation", handler: null },
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
const standing = (kind: "always" | "requirement", overrides: Partial<CallFacts> = {}) => {
  const base = call(write, overrides)
  return { ...base, tool: { ...base.tool, standing: kind } }
}

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
      "Automation directives, Never ask": verdict(
        decide(automation, live({ mode: "allow" }), standing("always"))
      ),
      "Automation directives, Auto": verdict(
        decide(automation, live({ mode: "safe" }), standing("always"))
      ),
      "person's own directives, Never ask": verdict(
        decide(person, live({ mode: "allow" }), standing("always"))
      ),
      "Automation Space setting that widens permissions, Never ask": verdict(
        decide(automation, live({ mode: "allow" }), standing("requirement", { requirement: true }))
      ),
      "Automation Space setting that does not, Never ask": verdict(
        decide(automation, live({ mode: "allow" }), standing("requirement"))
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
      "Automation directives, Never ask": { ask: "standing", helper: false, delivery: "chat" },
      "Automation directives, Auto": { ask: "standing", helper: false, delivery: "chat" },
      "person's own directives, Never ask": { allow: "mode" },
      "Automation Space setting that widens permissions, Never ask": {
        ask: "standing",
        helper: false,
        delivery: "chat"
      },
      "Automation Space setting that does not, Never ask": { allow: "mode" },
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
