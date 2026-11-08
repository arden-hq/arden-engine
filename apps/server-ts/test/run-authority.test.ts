import type { RunContext } from "@arden-hq/protocol/runs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  RunAuthoritySchema,
  deriveAuthority,
  approvalSources,
  handedAuthority,
  narrow,
  orphanAgentAuthority,
  rootOf,
  unrecordedAuthority,
  widerAxes,
  type AdmissionFacts,
  type AgentRequest,
  type AutomationFacts,
  type RunAuthority
} from "../src/execution/authority.js"
import type { RunCapability, RunPolicy, SessionResourceReach } from "../src/execution/policy.js"

const policy = (overrides: Partial<RunPolicy> = {}): RunPolicy => ({
  authority_session_id: "chat-1",
  budget_id: "budget",
  budget_generation: 0,
  execution: { mode: "inline", observe: false },
  capabilities: ["all"],
  auto_approve: false,
  google_accounts: null,
  space: null,
  ...overrides
})

const space = (spaceId: string): NonNullable<RunPolicy["space"]> => ({
  space_id: spaceId,
  generation: 1,
  inference: { enabled: false }
})

const personTurn = (sessionId: string, task: RunContext["task"] = null): RunContext => ({
  origin: { kind: "chat", session_id: sessionId, turn_id: "turn-1" },
  task
})

const automation = (
  id: string,
  purpose: AutomationFacts["purpose"],
  overrides: Partial<AutomationFacts> = {}
): AutomationFacts => ({
  automation_id: id,
  purpose,
  handler: null,
  owner_space_id: null,
  ...overrides
})

const facts = (overrides: Partial<AdmissionFacts>): AdmissionFacts => ({
  sessionId: "chat-1",
  context: personTurn("chat-1"),
  policy: policy(),
  originAutomation: null,
  chatAutomation: null,
  ...overrides
})

const decided = (authority: RunAuthority) => ({
  actor: authority.actor,
  automation: authority.owns.automation_id,
  task: authority.owns.task_item_id,
  follows: authority.approval.follows,
  memory: authority.memory,
  unattended: authority.unattended
})

describe("deriveAuthority", () => {
  it("places every kind of admitted run by its durable records", () => {
    const cases = {
      "person message, ordinary chat": facts({}),
      "answer in a normal chat": facts({
        context: personTurn("chat-1", { item_id: "task-1", generation: 2 })
      }),
      "answer in an Automation's chat": facts({
        sessionId: "auto-chat",
        context: personTurn("auto-chat"),
        policy: policy({ authority_session_id: "auto-chat" }),
        chatAutomation: automation("auto-1", "user_automation")
      }),
      "person in a Space thread": facts({
        sessionId: "thread",
        context: personTurn("thread"),
        policy: policy({ space: space("space-a") }),
        chatAutomation: automation("review-a", "space_review", { owner_space_id: "space-a" })
      }),
      "user Automation run": facts({
        sessionId: "auto-chat",
        context: {
          origin: { kind: "automation", automation_id: "auto-1", occurrence_id: "o1" },
          task: null
        },
        policy: policy({
          authority_session_id: "auto-chat",
          execution: { mode: "worker", observe: false }
        }),
        originAutomation: automation("auto-1", "user_automation"),
        chatAutomation: automation("auto-1", "user_automation")
      }),
      "user Automation run in a continued chat": facts({
        sessionId: "auto-chat",
        context: {
          origin: { kind: "automation", automation_id: "auto-1", occurrence_id: "o2" },
          task: null
        },
        policy: policy({ authority_session_id: "auto-chat" }),
        originAutomation: automation("auto-1", "user_automation")
      }),
      "Memory Capture": facts({
        sessionId: "capture-chat",
        context: {
          origin: { kind: "automation", automation_id: "builtin-capture", occurrence_id: "o1" },
          task: null
        },
        policy: policy({ authority_session_id: "capture-chat" }),
        originAutomation: automation("builtin-capture", "system", { handler: "memory_capture" }),
        chatAutomation: automation("builtin-capture", "system", { handler: "memory_capture" })
      }),
      "Task worker": facts({
        sessionId: "task-chat",
        context: {
          origin: { kind: "task", item_id: "task-1", occurrence_id: "o1" },
          task: { item_id: "task-1", generation: 3 }
        },
        policy: policy({ space: space("space-a"), execution: { mode: "worker", observe: false } }),
        chatAutomation: automation("tasks-a", "task_execution", { owner_space_id: "space-a" })
      }),
      "Space review": facts({
        sessionId: "thread",
        context: {
          origin: { kind: "space", space_id: "space-a", occurrence_id: "o1" },
          task: null
        },
        policy: policy({ space: space("space-a"), execution: { mode: "worker", observe: true } }),
        chatAutomation: automation("review-a", "space_review", { owner_space_id: "space-a" })
      }),
      "unrecorded origin": facts({ context: { origin: { kind: "unrecorded" }, task: null } })
    }
    const placed = Object.fromEntries(
      Object.entries(cases).map(([name, input]) => [name, decided(deriveAuthority(input))])
    )
    const person = (sessionId: string) => ({
      kind: "person",
      session_id: sessionId,
      turn_id: "turn-1"
    })
    expect(placed).toEqual({
      "person message, ordinary chat": {
        actor: person("chat-1"),
        automation: null,
        task: null,
        follows: { kind: "chat", session_id: "chat-1" },
        memory: { _tag: "Global" },
        unattended: false
      },
      "answer in a normal chat": {
        actor: person("chat-1"),
        automation: null,
        task: "task-1",
        follows: { kind: "chat", session_id: "chat-1" },
        memory: { _tag: "Global" },
        unattended: false
      },
      "answer in an Automation's chat": {
        actor: person("auto-chat"),
        automation: null,
        task: null,
        follows: { kind: "chat", session_id: "auto-chat" },
        memory: { _tag: "Global" },
        unattended: false
      },
      "person in a Space thread": {
        actor: person("thread"),
        automation: null,
        task: null,
        follows: { kind: "space_thread", space_id: "space-a" },
        memory: { _tag: "Global" },
        unattended: false
      },
      "user Automation run": {
        actor: {
          kind: "automation",
          automation_id: "auto-1",
          purpose: "user_automation",
          handler: null
        },
        automation: "auto-1",
        task: null,
        follows: { kind: "chat", session_id: "auto-chat" },
        memory: { _tag: "Global" },
        unattended: true
      },
      "user Automation run in a continued chat": {
        actor: {
          kind: "automation",
          automation_id: "auto-1",
          purpose: "user_automation",
          handler: null
        },
        automation: "auto-1",
        task: null,
        follows: { kind: "chat", session_id: "auto-chat" },
        memory: { _tag: "Global" },
        unattended: true
      },
      "Memory Capture": {
        actor: {
          kind: "automation",
          automation_id: "builtin-capture",
          purpose: "system",
          handler: "memory_capture"
        },
        automation: "builtin-capture",
        task: null,
        follows: { kind: "automation", automation_id: "builtin-capture" },
        memory: { _tag: "Capture" },
        unattended: true
      },
      "Task worker": {
        actor: { kind: "task_worker", item_id: "task-1", space_id: "space-a" },
        automation: "tasks-a",
        task: "task-1",
        follows: { kind: "space_thread", space_id: "space-a" },
        memory: { _tag: "Space", space_id: "space-a" },
        unattended: true
      },
      "Space review": {
        actor: { kind: "space_review", space_id: "space-a" },
        automation: "review-a",
        task: null,
        follows: { kind: "space_thread", space_id: "space-a" },
        memory: { _tag: "Space", space_id: "space-a" },
        unattended: true
      },
      "unrecorded origin": {
        actor: { kind: "unrecorded" },
        automation: null,
        task: null,
        follows: { kind: "chat", session_id: "chat-1" },
        memory: { _tag: "None" },
        unattended: true
      }
    })
    for (const input of Object.values(cases)) {
      const authority = deriveAuthority(input)
      expect(
        Schema.decodeUnknownSync(RunAuthoritySchema)(JSON.parse(JSON.stringify(authority)))
      ).toEqual(authority)
    }
  })
})

const request = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  mode: "research",
  sessionId: "agent-chat",
  parentRunId: "parent-run",
  workspaceRoot: null,
  taskItemId: null,
  ...overrides
})

const taskWorker = deriveAuthority(
  facts({
    sessionId: "task-chat",
    context: {
      origin: { kind: "task", item_id: "task-1", occurrence_id: "o1" },
      task: { item_id: "task-1", generation: 1 }
    },
    policy: policy({ space: space("space-a"), execution: { mode: "worker", observe: false } }),
    chatAutomation: automation("tasks-a", "task_execution", { owner_space_id: "space-a" })
  })
)
const spaceChat = deriveAuthority(
  facts({ policy: policy({ space: space("space-a") }), sessionId: "space-chat" })
)

const narrowed = (parent: RunAuthority, overrides: Partial<AgentRequest> = {}): RunAuthority => {
  const result = narrow(parent, request(overrides))
  if (result.kind !== "narrowed") throw new Error(`expected a delegate, got ${result.reason}`)
  return result.authority
}

describe("narrow", () => {
  it("keeps a delegate on its parent's root, Space and Memory", () => {
    const research = narrowed(spaceChat)
    const work = narrowed(taskWorker, { mode: "work" })
    const grandchild = narrowed(work, { parentRunId: "work-run", sessionId: "grandchild" })
    expect({
      research: {
        root: rootOf(research.actor),
        space: research.owns.space_id,
        memory: research.memory
      },
      work: { root: rootOf(work.actor), space: work.owns.space_id, memory: work.memory },
      grandchild: grandchild.delegation
    }).toEqual({
      research: { root: "person", space: "space-a", memory: { _tag: "Global" } },
      work: {
        root: "task_worker",
        space: "space-a",
        memory: { _tag: "Space", space_id: "space-a" }
      },
      grandchild: { depth: 2, chain: ["parent-run", "work-run"] }
    })
    expect(research.reach.capabilities).toEqual(["agent_research"])
    expect(work.unattended).toBe(true)
  })

  it("refuses to delegate from a run that only observes", () => {
    const review = deriveAuthority(
      facts({
        context: {
          origin: { kind: "space", space_id: "space-a", occurrence_id: "o1" },
          task: null
        },
        policy: policy({ space: space("space-a"), execution: { mode: "worker", observe: true } })
      })
    )
    expect(narrow(review, request())).toEqual({ kind: "refused", reason: "observer_delegation" })
  })

  it("lets a delegate drop shared sessions but rejects any added resource principal", () => {
    const resource: SessionResourceReach = {
      session_id: "source-chat",
      generation: 3,
      capabilities: ["browser"],
      authority_session_id: "owner-chat",
      authority_generation: 5
    }
    const parent = deriveAuthority(facts({ resourceSessions: [resource] }))
    expect(approvalSources(parent.approval.follows)).toEqual([
      { kind: "chat", session_id: "chat-1" },
      { kind: "chat", session_id: "source-chat" },
      { kind: "chat", session_id: "owner-chat" }
    ])
    const child = narrowed(parent)
    expect(child.approval).toEqual(parent.approval)
    const narrowerChild: RunAuthority = {
      ...child,
      reach: { ...child.reach, resource_sessions: [] }
    }
    const widerChild: RunAuthority = {
      ...child,
      reach: {
        ...child.reach,
        resource_sessions: [
          resource,
          {
            ...resource,
            session_id: "ungranted-chat"
          }
        ]
      }
    }
    const narrowedResource: RunAuthority = {
      ...child,
      reach: {
        ...child.reach,
        resource_sessions: [{ ...resource, capabilities: ["browser", "agent_code"] }]
      }
    }
    const widenedResource: RunAuthority = {
      ...child,
      reach: {
        ...child.reach,
        resource_sessions: [{ ...resource, capabilities: ["all"] }]
      }
    }

    expect(widerAxes(narrowerChild, parent)).toEqual([])
    expect(widerAxes(widerChild, parent)).toContain("reach")
    expect(widerAxes(narrowedResource, parent)).toEqual([])
    expect(widerAxes(widenedResource, parent)).toContain("reach")
  })

  it("never makes a delegate wider than its parent on any axis", () => {
    const capabilitySets: ReadonlyArray<readonly [RunCapability, ...Array<RunCapability>]> = [
      ["all"],
      ["read_only"],
      ["reports", "browser"],
      ["agent_code", "all"],
      ["space"]
    ]
    const roots = [
      spaceChat,
      taskWorker,
      unrecordedAuthority("legacy"),
      deriveAuthority(
        facts({
          context: {
            origin: { kind: "automation", automation_id: "auto-1", occurrence_id: "o1" },
            task: null
          },
          originAutomation: automation("auto-1", "system", { handler: "memory_capture" })
        })
      )
    ]
    const sandboxes: ReadonlyArray<RunAuthority["sandbox"]> = [
      { kind: "host_approved" },
      { kind: "code_agent", root: "/work/repo" },
      { kind: "code_agent", root: null }
    ]
    const parents = roots.flatMap((root) =>
      capabilitySets.flatMap((capabilities) =>
        sandboxes.map((sandbox): RunAuthority => ({
          ...root,
          reach: { capabilities, observe: false },
          sandbox
        }))
      )
    )
    const requests = (["code", "research", "work"] as const).flatMap((mode) =>
      [null, "/work/repo/sub", "/elsewhere"].flatMap((workspaceRoot) =>
        [null, "task-9"].map((taskItemId) => request({ mode, workspaceRoot, taskItemId }))
      )
    )
    const widened = parents.flatMap((parent) =>
      requests.flatMap((each) => {
        const child = narrowed(parent, each)
        const grandchild = narrowed(child, { mode: each.mode, parentRunId: "child-run" })
        return [
          ...widerAxes(child, parent).map((axis) => ({ axis, request: each, level: 1 })),
          ...widerAxes(grandchild, parent).map((axis) => ({ axis, request: each, level: 2 }))
        ]
      })
    )
    expect(parents).toHaveLength(60)
    expect(widened).toEqual([])
  })
})

describe("the run's cause", () => {
  const woken = deriveAuthority(
    facts({
      sessionId: "auto-chat",
      context: {
        origin: {
          kind: "automation",
          automation_id: "auto-1",
          occurrence_id: "o1",
          chain_depth: 1
        },
        task: null
      },
      originAutomation: automation("auto-1", "user_automation")
    })
  )
  const cause = (authority: RunAuthority) => ({
    automation: authority.owns.automation_id,
    depth: authority.owns.chain_depth
  })

  it("is fixed at admission; a delegate or a handed run keeps it whole, an orphan has none", () => {
    const agent = narrowed(woken, { mode: "work" })
    const person = deriveAuthority(facts({}))
    expect({
      woken: cause(woken),
      agent: cause(agent),
      grandchild: cause(narrowed(agent, { parentRunId: "agent-run", sessionId: "grandchild" })),
      handed: cause(handedAuthority(woken, person, request({ sessionId: "chat-1" }))),
      orphan: cause(orphanAgentAuthority(request())),
      person: cause(person)
    }).toEqual({
      woken: { automation: "auto-1", depth: 1 },
      agent: { automation: "auto-1", depth: 1 },
      grandchild: { automation: "auto-1", depth: 1 },
      handed: { automation: "auto-1", depth: 1 },
      orphan: { automation: null, depth: 0 },
      person: { automation: null, depth: 0 }
    })
  })

  it("a delegate that drops its depth is wider than its parent: it could wake a longer chain", () => {
    const agent = narrowed(woken)
    expect(widerAxes({ ...agent, owns: { ...agent.owns, chain_depth: 0 } }, woken)).toEqual([
      "owns"
    ])
  })

  it("an authority stored before the depth was kept still decodes, at depth 0", () => {
    const { chain_depth: _dropped, ...owns } = woken.owns
    const stored = JSON.parse(JSON.stringify({ ...woken, owns }))
    expect(Schema.decodeUnknownSync(RunAuthoritySchema)(stored).owns).toEqual({
      ...woken.owns,
      chain_depth: 0
    })
  })
})
