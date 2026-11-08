import { describe, expect, it } from "vitest"
import { deriveAuthority, type AdmissionFacts } from "../src/execution/authority.js"
import type { RunPolicy } from "../src/execution/policy.js"
import {
  isSystemJobRun,
  jobHoldsShell,
  matchesCommand,
  matchesTool,
  pathDecision,
  ruleDecision,
  ruleListsOf,
  type RunRules
} from "../src/execution/rules.js"
import type {
  PermissionRule,
  RuleDecision,
  RuleList
} from "../src/persistence/permissions/rules.js"
import { hostCommandNeed } from "../src/tools/shell-policy.js"
import { decide, type CallFacts, type ToolFacts } from "../src/execution/decide.js"

const policy = (spaceId: string | null): RunPolicy => ({
  budget_id: "budget",
  budget_generation: 0,
  execution: { mode: "inline", observe: false },
  capabilities: ["all"],
  auto_approve: false,
  google_accounts: null,
  space:
    spaceId === null ? null : { space_id: spaceId, generation: 1, inference: { enabled: false } }
})

const admitted = (facts: Partial<AdmissionFacts>) =>
  deriveAuthority({
    sessionId: "chat-1",
    context: { origin: { kind: "chat", session_id: "chat-1", turn_id: "t1" }, task: null },
    policy: policy(null),
    originAutomation: null,
    chatAutomation: null,
    ...facts
  })

const automation = (purpose: "user_automation" | "system", spaceId: string | null) =>
  admitted({
    context: {
      origin: { kind: "automation", automation_id: "auto", occurrence_id: "o1" },
      task: null
    },
    originAutomation: { automation_id: "auto", purpose, handler: null, owner_space_id: null },
    policy: policy(spaceId)
  })

const LAB: RuleList = { kind: "space", spaceId: "lab" }
const GLOBAL: RuleList = { kind: "global" }

const rule = (list: RuleList, decision: RuleDecision, tool = "browser_act"): PermissionRule => ({
  id: `${list.kind}-${decision}-${tool}`,
  subject: { kind: "tool", tool, server: null },
  list,
  decision,
  source: { kind: "settings", runId: null },
  createdAt: "2026-10-31T00:00:00.000Z",
  fromRuleId: null
})

const browser = (own: RuleList | undefined, rules: ReadonlyArray<PermissionRule>) =>
  ruleDecision(
    { own, rules } satisfies RunRules,
    matchesTool({ tool: "browser_act", server: null, site: undefined })
  )

describe("which lists a run reads", () => {
  it.each([
    ["a chat in a Space", admitted({ policy: policy("lab") }), [LAB, GLOBAL]],
    ["a chat in no Space", admitted({}), [GLOBAL]],
    [
      "a user automation whose chat is in a Space",
      automation("user_automation", "lab"),
      [LAB, GLOBAL]
    ],
    ["a user automation whose chat is in no Space", automation("user_automation", null), [GLOBAL]],
    ["Arden's own job with no Space", automation("system", null), [{ kind: "system" }, GLOBAL]]
  ] as const)("%s", (_case, authority, lists) => {
    expect(ruleListsOf(authority)).toEqual(lists)
  })
})

describe("the order the rules decide in", () => {
  it.each([
    [
      "a Space ask beats a global allow inside the Space",
      LAB,
      [rule(GLOBAL, "allow"), rule(LAB, "ask")],
      "ask"
    ],
    [
      "a Space allow beats a global ask inside the Space",
      LAB,
      [rule(GLOBAL, "ask"), rule(LAB, "allow")],
      "allow"
    ],
    [
      "a global never is a floor no Space allow lifts",
      LAB,
      [rule(GLOBAL, "never"), rule(LAB, "allow")],
      "never"
    ],
    [
      "a Space never refuses inside the Space",
      LAB,
      [rule(GLOBAL, "allow"), rule(LAB, "never")],
      "never"
    ],
    [
      "outside the Space, a Space ask is not read",
      undefined,
      [rule(GLOBAL, "allow"), rule(LAB, "ask")],
      "allow"
    ],
    [
      "outside the Space, a Space allow is not read",
      undefined,
      [rule(GLOBAL, "ask"), rule(LAB, "allow")],
      "ask"
    ],
    [
      "a Space with no rule for the tool falls to the global list",
      LAB,
      [rule(GLOBAL, "ask"), rule(LAB, "allow", "email_send")],
      "ask"
    ],
    [
      "no rule for the tool leaves it to the mode",
      LAB,
      [rule(LAB, "allow", "email_send")],
      undefined
    ]
  ] as const)("%s", (_case, own, rules, decision) => {
    expect(browser(own, rules)).toBe(decision)
  })

  it("a connector rule covers every tool of its server, and a tool's own rule beats it only by rank", () => {
    const connector: PermissionRule = {
      ...rule(GLOBAL, "allow"),
      id: "connector",
      subject: { kind: "connector", server: "github" }
    }
    const call = matchesTool({
      tool: "mcp__github__create_issue",
      server: "github",
      site: undefined
    })
    expect(ruleDecision({ own: undefined, rules: [connector] }, call)).toBe("allow")
    expect(
      ruleDecision(
        { own: undefined, rules: [connector, rule(GLOBAL, "ask", "mcp__github__create_issue")] },
        call
      )
    ).toBe("ask")
    expect(
      ruleDecision(
        { own: undefined, rules: [connector] },
        matchesTool({ tool: "x", server: null, site: undefined })
      )
    ).toBe(undefined)
  })
})

describe("a host command", () => {
  it.each([
    [
      "host ask with a command allow",
      { hostAsk: true, rule: "allow", modeSkips: false },
      "owner_card"
    ],
    ["host ask in Never ask", { hostAsk: true, rule: undefined, modeSkips: true }, "owner_card"],
    [
      "a command never beats the host ask",
      { hostAsk: true, rule: "never", modeSkips: true },
      "refuse"
    ],
    ["a command ask in Never ask", { hostAsk: false, rule: "ask", modeSkips: true }, "card"],
    ["a command allow", { hostAsk: false, rule: "allow", modeSkips: false }, "none"],
    ["no rule, the mode runs it", { hostAsk: false, rule: undefined, modeSkips: true }, "none"],
    ["no rule, the mode asks", { hostAsk: false, rule: undefined, modeSkips: false }, "card"]
  ] as const)("%s", (_case, input, need) => {
    expect(hostCommandNeed({ systemJob: false, ...input })).toBe(need)
  })

  it.each([
    ["no rule", { hostAsk: false, rule: undefined, modeSkips: true }, "unlisted"],
    ["a command ask", { hostAsk: false, rule: "ask", modeSkips: true }, "unlisted"],
    ["a command allow", { hostAsk: false, rule: "allow", modeSkips: true }, "none"],
    ["a command never", { hostAsk: false, rule: "never", modeSkips: true }, "refuse"]
  ] as const)("in a built-in job: %s", (_case, input, need) => {
    expect(hostCommandNeed({ systemJob: true, ...input })).toBe(need)
  })
})

describe("a built-in job's shell", () => {
  const SYSTEM: RuleList = { kind: "system" }
  const git = { executable: "/usr/bin/git", arguments: ["status"] }
  const command = (
    list: RuleList,
    decision: RuleDecision,
    executable = "/usr/bin/git"
  ): PermissionRule => ({
    ...rule(list, decision),
    id: `${list.kind}-${decision}-${executable}`,
    subject: { kind: "command", executable, argumentPrefix: [] }
  })
  const job = automation("system", null)
  const runRules = (rules: ReadonlyArray<PermissionRule>): RunRules => ({
    own: SYSTEM,
    rules
  })

  it("is held only with a command allow in the jobs' list", () => {
    expect(jobHoldsShell(job, runRules([]))).toBe(false)
    expect(jobHoldsShell(job, runRules([command(GLOBAL, "allow")]))).toBe(false)
    expect(jobHoldsShell(job, runRules([rule(SYSTEM, "allow", "exec_command")]))).toBe(false)
    expect(jobHoldsShell(job, runRules([command(SYSTEM, "ask")]))).toBe(false)
    expect(jobHoldsShell(job, runRules([command(SYSTEM, "allow")]))).toBe(true)
    expect(jobHoldsShell(job, runRules([]))).toBe(false)
  })

  it("is held by no run but a built-in job's", () => {
    const rules = runRules([command(SYSTEM, "allow")])
    expect(jobHoldsShell(automation("user_automation", null), rules)).toBe(false)
    expect(jobHoldsShell(automation("system", "lab"), rules)).toBe(false)
    expect(jobHoldsShell(admitted({}), rules)).toBe(false)
  })

  it("is a built-in job's alone, not a user Automation's or a person's", () => {
    expect(isSystemJobRun(job)).toBe(true)
    expect(isSystemJobRun(automation("user_automation", null))).toBe(false)
    expect(isSystemJobRun(automation("system", "lab"))).toBe(false)
    expect(isSystemJobRun(admitted({}))).toBe(false)
  })

  it("reads the global list's command rules as any run does", () => {
    const own = command(SYSTEM, "allow")
    const call = matchesCommand(git)
    expect(ruleDecision(runRules([own]), call)).toBe("allow")
    expect(ruleDecision(runRules([own, command(GLOBAL, "allow", "/usr/bin/coast")]), call)).toBe(
      "allow"
    )
    expect(
      ruleDecision(
        runRules([own, command(GLOBAL, "allow", "/usr/bin/coast")]),
        matchesCommand({ executable: "/usr/bin/coast", arguments: [] })
      )
    ).toBe("allow")
    expect(ruleDecision(runRules([own, command(GLOBAL, "never")]), call)).toBe("never")
  })
})

it("a site rule decides its tool on its site and nowhere else", () => {
  const site = (origin: string, decision: RuleDecision): PermissionRule => ({
    ...rule(LAB, decision),
    id: `site-${origin}-${decision}`,
    subject: { kind: "site", tool: "browser_act", origin }
  })
  const on = (origin: string | undefined, rules: ReadonlyArray<PermissionRule>) =>
    ruleDecision(
      { own: LAB, rules },
      matchesTool({ tool: "browser_act", server: null, site: origin })
    )
  const lever = site("https://jobs.lever.co", "allow")
  expect({
    "its site": on("https://jobs.lever.co", [lever]),
    "another site": on("https://evil.example", [lever]),
    "no site": on(undefined, [lever]),
    "beside the tool's own ask": on("https://jobs.lever.co", [lever, rule(LAB, "ask")]),
    "under a global never": on("https://jobs.lever.co", [lever, rule(GLOBAL, "never")])
  }).toEqual({
    "its site": "allow",
    "another site": undefined,
    "no site": undefined,
    "beside the tool's own ask": "ask",
    "under a global never": "never"
  })
})

it("an allow rule for uploads does not skip the outside-folder card", () => {
  const upload: ToolFacts = {
    name: "browser_upload",
    effect: "external",
    action: "execute",
    changes_state: true,
    read_only_mode: undefined,
    default_approval: "ask",
    always_ask: false,
    approval_bypass: false,
    refuse_unattended: true,
    per_call: true,
    standing: undefined
  }
  const call = (requirement: boolean): CallFacts => ({
    tool: upload,
    available: true,
    unattended_scope: false,
    floor: undefined,
    target: undefined,
    requirement,
    user_only: true,
    reads_only: false,
    impact: { kind: "outward", category: "external_send" },
    approved: false
  })
  const live = { state: "active", mode: "allow", rule: "allow" } as const
  expect(decide(admitted({}), live, call(true))).toMatchObject({
    kind: "ask",
    reason: "requirement"
  })
  expect(decide(admitted({}), live, call(false)).kind).toBe("allow")
})

describe("a path rule", () => {
  const pathRule = (
    list: RuleList,
    decision: "allow" | "never",
    path: string,
    access: "read" | "change"
  ): PermissionRule => ({
    id: `${list.kind}-${decision}-${access}-${path}`,
    subject: { kind: "path", path, access },
    list,
    decision,
    source: { kind: "settings", runId: null },
    createdAt: "2026-11-01T00:00:00.000Z",
    fromRuleId: null
  })
  const decides = (
    rules: ReadonlyArray<PermissionRule>,
    target: string | { lexical: string; real: string },
    access: "read" | "change",
    foldCase = false
  ) =>
    pathDecision(
      { own: LAB, rules },
      typeof target === "string" ? { lexical: target, real: target } : target,
      access,
      foldCase
    )

  it("never in any list wins over an allow, a deeper one too", () => {
    const rules = [
      pathRule(GLOBAL, "never", "/Users/me/Documents", "read"),
      pathRule(LAB, "allow", "/Users/me/Documents/demo", "change")
    ]
    expect(decides(rules, "/Users/me/Documents/demo/a.md", "change")).toBe("never")
    expect(decides(rules, "/Users/me/Documents/demo/a.md", "read")).toBe("never")
  })

  it("a never on changing leaves reading alone; a never on reading stops both", () => {
    const noChange = [pathRule(LAB, "never", "/Users/me/taxes", "change")]
    expect(decides(noChange, "/Users/me/taxes/2026.pdf", "read")).toBeUndefined()
    expect(decides(noChange, "/Users/me/taxes/2026.pdf", "change")).toBe("never")
  })

  it("an allow to change also allows using; an allow to use does not allow changing", () => {
    expect(
      decides(
        [pathRule(LAB, "allow", "/Users/me/src/demo", "change")],
        "/Users/me/src/demo/x",
        "read"
      )
    ).toBe("allow")
    expect(
      decides([pathRule(LAB, "allow", "/Users/me/cv", "read")], "/Users/me/cv/cv.pdf", "change")
    ).toBeUndefined()
  })

  it("holds only inside its folder, not beside it", () => {
    const rules = [pathRule(LAB, "never", "/Users/me/src/demo", "read")]
    expect(decides(rules, "/Users/me/src/demo-two/a", "read")).toBeUndefined()
    expect(decides(rules, "/Users/me/src/demo", "read")).toBe("never")
  })

  it("a never matches the path as asked for and its real path, any case where the disk ignores case", () => {
    const rules = [pathRule(LAB, "never", "/Users/me/Documents", "read")]
    expect(
      decides(rules, { lexical: "/Users/me/link/a", real: "/Users/me/Documents/a" }, "read")
    ).toBe("never")
    expect(decides(rules, { lexical: "/Users/me/Documents/a", real: "/Volumes/x/a" }, "read")).toBe(
      "never"
    )
    expect(decides(rules, "/Users/me/DOCUMENTS/a", "read", true)).toBe("never")
    expect(decides(rules, "/Users/me/DOCUMENTS/a", "read", false)).toBeUndefined()
  })

  it("an allow holds only on the real path: a link into it from outside is not allowed", () => {
    const rules = [pathRule(LAB, "allow", "/Users/me/src/demo", "change")]
    expect(
      decides(rules, { lexical: "/Users/me/src/demo/link", real: "/etc/hosts" }, "change")
    ).toBeUndefined()
  })

  it("another Space's rule does not reach this run", () => {
    const other: RuleList = { kind: "space", spaceId: "other" }
    expect(
      pathDecision(
        { own: LAB, rules: [] },
        { lexical: "/Users/me/a", real: "/Users/me/a" },
        "read",
        false
      )
    ).toBeUndefined()
    expect(ruleListsOf(automation("system", "lab"))).not.toContainEqual(other)
  })
})
