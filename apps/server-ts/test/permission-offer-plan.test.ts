import { homedir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { ToolFacts } from "../src/execution/decide.js"
import type { OfferHolders } from "../src/persistence/permissions/offer.js"
import { wordsRuleText, type PermissionRule } from "../src/persistence/permissions/rules.js"
import type { PermissionStore } from "../src/persistence/permissions/store.js"
import type { WorkStore } from "../src/persistence/work/store.js"
import {
  makePermissionOffers,
  planPermissionOffer,
  type OfferFacts
} from "../src/tools/permission-offer.js"
import { partialService, runAuthority, serverRunContext } from "./kit.js"

const browser: ToolFacts = {
  name: "browser_act",
  effect: "external",
  action: "execute",
  changes_state: true,
  read_only_mode: undefined,
  default_approval: "ask",
  always_ask: false,
  approval_bypass: false,
  refuse_unattended: false,
  per_call: false,
  standing: undefined
}

const spaceChat: OfferHolders = {
  shared: { kind: "space", principal: "space:jobs", name: "Hiring" }
}

const looseChat: OfferHolders = { shared: null }

type ToolInput = Partial<Omit<Extract<OfferFacts, { kind: "tool" }>, "kind">>

const plan = (input: ToolInput = {}) =>
  planPermissionOffer({
    kind: "tool",
    decision: "approve",
    tool: browser,
    rule: undefined,
    holders: spaceChat,
    ...input
  })

const ids = (offered: ReturnType<typeof planPermissionOffer>) =>
  offered.kind === "offer" ? offered.choices.map(({ id, principal }) => [id, principal]) : offered

const gitPush = {
  executable_path: "/usr/bin/git",
  argument_prefix: ["push"],
  display_prefix: "git push …"
}

const command = (input: Partial<Omit<Extract<OfferFacts, { kind: "command" }>, "kind">> = {}) =>
  planPermissionOffer({
    kind: "command",
    grant: { rule: undefined, displayPrefixes: ["git push …"], offer: { rules: [gitPush] } },
    system: { rule: undefined, displayPrefixes: ["git push …"], offer: { rules: [gitPush] } },
    alwaysAsk: false,
    rule: undefined,
    holders: spaceChat,
    ...input
  })

const connector = (input: Partial<Omit<Extract<OfferFacts, { kind: "connector" }>, "kind">> = {}) =>
  planPermissionOffer({
    kind: "connector",
    server: "GitHub",
    tools: 3,
    rule: undefined,
    holders: spaceChat,
    ...input
  })

describe("what Arden may offer to stop asking about", () => {
  it.each([
    [
      "a tool that always asks",
      { tool: { ...browser, always_ask: true }, rule: "approve" },
      "always_asks"
    ],
    ["the person's own Ask in Settings", { rule: "ask" }, "your_setting"],
    ["the person's own Off in Settings", { rule: "deny" }, "your_setting"],
    ["a tool allowed in Settings", { rule: "approve" }, "already_allowed"],
    [
      "the command tool, whose prefix is offered as a command",
      { tool: { ...browser, name: "exec_command", per_call: true } },
      "own_rule"
    ],
    [
      "a tool that runs without asking",
      { tool: { ...browser, default_approval: "approve" } },
      "does_not_ask"
    ],
    ["Ask where the person already set Ask", { decision: "ask", rule: "ask" }, "already_set"],
    [
      "Off for the run's own record",
      { decision: "deny", tool: { ...browser, effect: "run_record" } },
      "own_record"
    ]
  ] as const)("offers nothing for %s", (_case, input, reason) => {
    expect(plan(input)).toEqual({ kind: "refuse", reason })
  })

  it("offers the run's Space and everywhere, and only everywhere outside a Space", () => {
    expect(ids(plan())).toEqual([
      ["space", "space:jobs"],
      ["everywhere", null]
    ])
    expect(ids(plan({ holders: looseChat }))).toEqual([["everywhere", null]])
  })

  it("offers Ask and Off in the run's Space or everywhere, over the person's Allow", () => {
    const off = plan({ decision: "deny", rule: "approve" })
    expect(off.kind === "offer" && off.change).toEqual({
      kind: "tool",
      tool: "browser_act",
      decision: "deny"
    })
    expect(ids(off)).toEqual([
      ["space", "space:jobs"],
      ["everywhere", null]
    ])
  })
})

describe("a browser action from the person's approvals", () => {
  const site = (input: Partial<Omit<Extract<OfferFacts, { kind: "site" }>, "kind">> = {}) =>
    planPermissionOffer({
      kind: "site",
      tool: { ...browser, per_call: true },
      origin: "https://jobs.lever.co",
      rule: undefined,
      holders: spaceChat,
      ...input
    })

  it("offers the tool on that site in the run's Space or everywhere", () => {
    const offered = site()
    expect(offered.kind === "offer" && offered.change).toEqual({
      kind: "site",
      tool: "browser_act",
      origin: "https://jobs.lever.co"
    })
    expect(ids(offered)).toEqual([
      ["space", "space:jobs"],
      ["everywhere", null]
    ])
  })

  it.each([
    ["the person's own Ask", { rule: "ask" }, "your_setting"],
    ["a site already allowed", { rule: "approve" }, "already_allowed"],
    ["a tool that always asks", { tool: { ...browser, always_ask: true } }, "always_asks"]
  ] as const)("offers nothing for %s", (_case, input, reason) => {
    expect(site(input)).toEqual({ kind: "refuse", reason })
  })
})

describe("a connector from the person's words", () => {
  it.each([
    ["a connector the chat has no tools of", { tools: 0 }, "no_connector"],
    ["the person's own ask for the connector", { rule: "ask" }, "your_setting"],
    ["the person's own never for the connector", { rule: "deny" }, "your_setting"],
    ["a connector already allowed", { rule: "approve" }, "already_allowed"]
  ] as const)("offers nothing for %s", (_case, input, reason) => {
    expect(connector(input)).toEqual({ kind: "refuse", reason })
  })

  it("offers the connector's rule in the run's Space or everywhere", () => {
    const offered = connector()
    expect(offered.kind === "offer" && offered.change).toEqual({
      kind: "connector",
      server: "GitHub"
    })
    expect(ids(offered)).toEqual([
      ["space", "space:jobs"],
      ["everywhere", null]
    ])
    expect(ids(connector({ holders: looseChat }))).toEqual([["everywhere", null]])
  })
})

describe("who may raise an offer", () => {
  const offers = makePermissionOffers({
    permissions: partialService<PermissionStore["Service"]>("PermissionStore", {}),
    work: partialService<WorkStore["Service"]>("WorkStore", {}),
    live: () => Promise.reject(new Error("live is outside this test")),
    modeHolder: () => Promise.reject(new Error("modeHolder is outside this test")),
    commandGrant: () => Promise.reject(new Error("commandGrant is outside this test")),
    connectorTitles: () => Promise.reject(new Error("connectorTitles is outside this test")),
    compileWords: () => Promise.reject(new Error("compileWords is outside this test"))
  })
  const actors = [
    [
      "an Automation",
      { kind: "automation", automation_id: "a", purpose: "user_automation", handler: null }
    ],
    ["a Space's worker", { kind: "task_worker", item_id: "i", space_id: "jobs" }],
    ["an agent", { kind: "agent", mode: "work", parent_run_id: "r", root: "person" }],
    [
      "a built-in job",
      { kind: "automation", automation_id: "a", purpose: "system", handler: "daily_summary" }
    ]
  ] as const
  it.each(
    actors.flatMap(([name, actor]) => [
      [name, actor, { kind: "connector", server: "github" }] as const,
      [name, actor, { kind: "command", command: "git push" }] as const,
      [name, actor, { kind: "words", text: "send any email", decision: "allow" }] as const,
      [name, actor, { kind: "rule", ruleId: "r1", decision: "remove" }] as const
    ])
  )("%s asking from its own words offers nothing: %o", async (_name, actor, request) => {
    const outcome = await offers.offer({
      run: serverRunContext({ authority: runAuthority({ actor }) }),
      toolCallId: "ask",
      request,
      tools: [],
      source: { kind: "message" }
    })
    expect(outcome).toEqual({ kind: "refused", reason: expect.any(String) })
  })
  it.each(actors)("%s approving a card three times offers nothing", async (_name, actor) => {
    const outcome = await offers.offer({
      run: serverRunContext({ authority: runAuthority({ actor }) }),
      toolCallId: "call",
      request: { kind: "tool", tool: "browser_act", decision: "approve" },
      tools: [],
      source: { kind: "approvals" }
    })
    expect(outcome).toEqual({ kind: "skipped" })
  })
})

describe("the approval mode from the person's words", () => {
  it.each([
    ["a run whose mode a Space or job sets", { holder: undefined }, "mode_elsewhere"],
    [
      "the mode the holding chat already has",
      { holder: { principal: "chat:c1", name: "Kev", own: true, mode: "allow" } },
      "already_set"
    ]
  ] as const)("offers nothing for %s", (_case, input, reason) => {
    expect(planPermissionOffer({ kind: "mode", requested: "allow", ...input })).toEqual({
      kind: "refuse",
      reason
    })
  })

  it("offers Never ask held by the chat whose setting the run follows", () => {
    expect(
      planPermissionOffer({
        kind: "mode",
        requested: "allow",
        holder: { principal: "chat:c1", name: "Kev", own: true, mode: "safe" }
      })
    ).toEqual({
      kind: "offer",
      change: { kind: "mode", mode: "allow" },
      choices: [{ id: "chat", principal: "chat:c1", label: "In this chat", detail: "Kev" }]
    })
  })
})

describe("a command prefix from the person's words", () => {
  it.each([
    ["the person's ask for every host command", { alwaysAsk: true }, "your_setting"],
    ["the command tool turned off", { rule: "deny" }, "your_setting"],
    [
      "a prefix already saved",
      {
        grant: { rule: "allow", displayPrefixes: ["git push …"] },
        system: { rule: "allow", displayPrefixes: ["git push …"] }
      },
      "already_allowed"
    ],
    [
      "a command Arden keeps no rule for",
      {
        grant: { rule: undefined, displayPrefixes: [] },
        system: { rule: undefined, displayPrefixes: [] }
      },
      "no_rule"
    ]
  ] as const)("offers nothing for %s", (_case, input, reason) => {
    expect(command(input)).toEqual({ kind: "refuse", reason })
  })

  it("offers the prefixes its card would offer: the run's Space, everywhere, Arden's own jobs", () => {
    const offered = command()
    expect(offered.kind === "offer" && offered.change).toEqual({
      kind: "command",
      rules: [gitPush]
    })
    expect(ids(offered)).toEqual([
      ["space", "space:jobs"],
      ["everywhere", null],
      ["system", null]
    ])
    expect(ids(command({ holders: looseChat }))).toEqual([
      ["everywhere", null],
      ["system", null]
    ])
  })

  it("judges Arden's own jobs by their own list", () => {
    const everywhere = { rule: "allow", displayPrefixes: ["git push …"] } as const
    expect(ids(command({ grant: everywhere }))).toEqual([["system", null]])
    const held = { rule: "allow", displayPrefixes: ["git push …"] } as const
    expect(ids(command({ system: held }))).toEqual([
      ["space", "space:jobs"],
      ["everywhere", null]
    ])
    expect(command({ grant: everywhere, system: held })).toEqual({
      kind: "refuse",
      reason: "already_allowed"
    })
    const refused = { rule: "never", displayPrefixes: ["git push …"] } as const
    expect(ids(command({ system: refused }))).toEqual([
      ["space", "space:jobs"],
      ["everywhere", null]
    ])
  })

  it("still refuses to change a rule in the jobs' list", () => {
    const rule: PermissionRule = {
      id: "r1",
      list: { kind: "system" },
      subject: { kind: "command", executable: "/usr/bin/git", argumentPrefix: ["push"] },
      decision: "allow",
      source: { kind: "settings", runId: null },
      createdAt: "2026-11-04T00:00:00.000Z",
      fromRuleId: null
    }
    expect(planPermissionOffer({ kind: "rule", rule, decision: "remove" })).toEqual({
      kind: "refuse",
      reason: "system_list"
    })
  })
})

describe("an offer from the person's words in any mode", () => {
  it("offers a tool whose own check asks for some calls, as an upload's does", () => {
    const upload = plan({ tool: { ...browser, name: "browser_upload", per_call: true } })
    expect(upload.kind === "offer" && upload.change).toEqual({
      kind: "tool",
      tool: "browser_upload",
      decision: "approve"
    })
  })

  const asked: Array<Parameters<WorkStore["Service"]["askQuestion"]>[0]> = []
  const DOCUMENTS = join(homedir(), "Documents")
  const offersIn = (mode: "allow" | "read_only" | "safe") =>
    makePermissionOffers({
      permissions: partialService<PermissionStore["Service"]>("PermissionStore", {
        offerHolders: () => Effect.succeed(spaceChat),
        allowSaves: () => Effect.succeed(true),
        offerHistory: () => Effect.succeed({ approvals: 3, offer: "none" })
      }),
      work: partialService<WorkStore["Service"]>("WorkStore", {
        askQuestion: (input) => {
          asked.push(input)
          const question = { question_id: "q1", content: input.content }
          return Effect.succeed(question as never)
        }
      }),
      live: () =>
        Promise.resolve({
          state: "active",
          mode,
          noApproval: false,
          currentScope: undefined,
          rules: { own: undefined, rules: [] }
        }),
      modeHolder: () => Promise.resolve(undefined),
      commandGrant: () => Promise.reject(new Error("commandGrant is outside this test")),
      connectorTitles: () => Promise.resolve(new Map()),
      compileWords: (text) =>
        Promise.resolve({
          decision: "never" as const,
          rules: text.includes("Documents")
            ? [
                {
                  decision: "never" as const,
                  wire: { kind: "path" as const, path: DOCUMENTS, access: "read" as const },
                  subject: { kind: "path" as const, path: DOCUMENTS, access: "read" as const }
                }
              ]
            : [],
          dropped: []
        })
    })
  const words = { kind: "words", text: "uploading my CV to job sites", decision: "allow" } as const

  it.each(["allow", "read_only", "safe"] as const)("offers in %s mode", async (mode) => {
    const outcome = await offersIn(mode).offer({
      run: serverRunContext(),
      toolCallId: "ask",
      request: words,
      tools: [],
      source: { kind: "message" }
    })
    expect(outcome).toMatchObject({ kind: "offered", questionId: "q1" })
  })

  it("shows every word of a words rule it saves", async () => {
    asked.length = 0
    const text = `${"Upload my CV to job application sites. ".repeat(4)}\nAlso send email and delete files.`
    const said = wordsRuleText(text)
    await offersIn("safe").offer({
      run: serverRunContext(),
      toolCallId: "ask",
      request: { kind: "words", text: said, decision: "allow" },
      tools: [],
      source: { kind: "message" }
    })
    const question = asked[0]
    expect(question?.permissionOffer?.change).toMatchObject({ kind: "words", text: said })
    expect(question?.content.prompt).toContain(`“${said}”`)
  })

  it("compiles words into the hard rules the card shows and the tap saves", async () => {
    asked.length = 0
    await offersIn("safe").offer({
      run: serverRunContext(),
      toolCallId: "ask",
      request: { kind: "words", text: "never touch Documents", decision: "allow" },
      tools: [],
      source: { kind: "message" }
    })
    expect(asked[0]?.permissionOffer?.change).toEqual({
      kind: "words",
      text: "never touch Documents",
      decision: "never",
      rules: [{ subject: { kind: "path", path: DOCUMENTS, access: "read" }, decision: "never" }]
    })
    expect(asked[0]?.content.detail).toBe("- Deny: Read files in ~/Documents")
    asked.length = 0
    await offersIn("safe").offer({
      run: serverRunContext(),
      toolCallId: "ask-2",
      request: { kind: "words", text: "never email anyone outside my company", decision: "never" },
      tools: [],
      source: { kind: "message" }
    })
    expect(asked[0]?.permissionOffer?.change).toMatchObject({ kind: "words", rules: [] })
    expect(asked[0]?.content.detail).toBeNull()
  })

  it("offers nothing from approvals where no card asks", async () => {
    const outcome = await offersIn("allow").offer({
      run: serverRunContext(),
      toolCallId: "call",
      request: words,
      tools: [],
      source: { kind: "approvals" }
    })
    expect(outcome).toEqual({ kind: "skipped" })
  })
})

describe("changing or removing a rule from the person's words", () => {
  const rule = (list: PermissionRule["list"]): PermissionRule => ({
    id: "r1",
    subject: { kind: "tool", tool: "browser_upload", server: null },
    list,
    decision: "allow",
    source: { kind: "settings", runId: null },
    createdAt: null,
    fromRuleId: null
  })
  const change = (input: Partial<Omit<Extract<OfferFacts, { kind: "rule" }>, "kind">>) =>
    planPermissionOffer({
      kind: "rule",
      rule: rule({ kind: "global" }),
      decision: "remove",
      ...input
    })

  it.each([
    ["an id no rule of the run has", { rule: undefined }, "no_rule_id"],
    ["the decision the rule already has", { decision: "allow" }, "already_set"],
    ["a rule on Arden's own jobs' list", { rule: rule({ kind: "system" }) }, "system_list"],
    [
      "an allow for commands on your Mac, which only asks",
      {
        rule: { ...rule({ kind: "global" }), subject: { kind: "host_commands" }, decision: "ask" },
        decision: "allow"
      },
      "host_commands"
    ]
  ] as const)("offers nothing for %s", (_case, input, reason) => {
    expect(change(input)).toEqual({ kind: "refuse", reason })
  })

  it("offers the change only in the list the rule sits in", () => {
    expect(ids(change({}))).toEqual([["everywhere", null]])
    expect(
      ids(change({ rule: rule({ kind: "space", spaceId: "jobs" }), decision: "ask" }))
    ).toEqual([["space", "space:jobs"]])
  })
})
