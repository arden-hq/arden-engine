import { homedir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { McpStore } from "../src/persistence/mcp/store.js"
import { PermissionRules, type RuleInput } from "../src/persistence/permissions/rules.js"
import { cardRuleList } from "../src/persistence/sqlite/permissions.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const browser = { kind: "tool", tool: "browser_act", server: null } as const

const settings = (input: Omit<RuleInput, "source">): RuleInput => ({
  ...input,
  source: { kind: "settings" }
})

let attempts = 0
const allowIsOverridden = (
  rules: PermissionRules["Service"],
  subject: RuleInput["subject"],
  list: RuleInput["list"]
) =>
  Effect.gen(function* () {
    attempts += 1
    yield* rules.saveWords({
      text: `allow ${attempts}`,
      list,
      decision: "allow",
      rules: [{ subject, decision: "allow" }],
      source: { kind: "settings" }
    })
    const held = yield* rules.list()
    return !held.some(
      (rule) =>
        rule.decision === "allow" &&
        JSON.stringify(rule.subject) === JSON.stringify(subject) &&
        JSON.stringify(rule.list) === JSON.stringify(list)
    )
  })

it("a second rule for the same subject in the same list replaces the first, and no other list's", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const rules = yield* PermissionRules
      const created = yield* (yield* SpaceStore).create({ name: "Lab" })
      const space = { kind: "space", spaceId: created.space_id } as const
      const first = yield* rules.save(
        settings({ subject: browser, list: { kind: "global" }, decision: "allow" })
      )
      yield* rules.save(settings({ subject: browser, list: space, decision: "never" }))
      const same = yield* rules.save(
        settings({ subject: browser, list: { kind: "global" }, decision: "allow" })
      )
      expect(same.id).toBe(first.id)
      const replaced = yield* rules.save({
        subject: browser,
        list: { kind: "global" },
        decision: "ask",
        source: { kind: "card", runId: "run", toolCallId: "call" }
      })
      expect(replaced.id).toBe(first.id)
      expect(
        (yield* rules.list())
          .map(({ list, decision, source }) => ({ list, decision, source }))
          .sort((left, right) => left.list.kind.localeCompare(right.list.kind))
      ).toEqual([
        { list: { kind: "global" }, decision: "ask", source: { kind: "card", runId: "run" } },
        { list: space, decision: "never", source: { kind: "settings", runId: null } }
      ])
      const loosened = yield* rules
        .save(settings({ subject: { kind: "host_commands" }, list: space, decision: "allow" }))
        .pipe(Effect.result)
      expect(loosened).toMatchObject({ _tag: "Failure", failure: { reason: "invalid" } })
    })
  )
})

it("a card's or an offer's allow never lands over a rule the person set", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const rules = yield* PermissionRules
      const spaces = yield* SpaceStore
      const lab = {
        kind: "space",
        spaceId: (yield* spaces.create({ name: "Lab" })).space_id
      } as const
      const jobs = {
        kind: "space",
        spaceId: (yield* spaces.create({ name: "Jobs" })).space_id
      } as const
      const tool = (name: string) => ({ kind: "tool", tool: name, server: null }) as const
      yield* rules.save(settings({ subject: tool("space_ask"), list: lab, decision: "ask" }))
      yield* rules.save(settings({ subject: tool("space_never"), list: lab, decision: "never" }))
      yield* rules.save(
        settings({ subject: tool("global_ask"), list: { kind: "global" }, decision: "ask" })
      )
      yield* rules.save(
        settings({ subject: tool("global_allow"), list: { kind: "global" }, decision: "allow" })
      )
      yield* rules.save(settings({ subject: tool("other_space"), list: jobs, decision: "ask" }))
      const push = {
        kind: "command",
        executable: "/usr/bin/git",
        argumentPrefix: ["push"]
      } as const
      const github = { kind: "connector", server: "github" } as const
      yield* (yield* McpStore).create({
        name: "github",
        enabled: true,
        presetId: null,
        transport: {
          type: "http",
          url: "https://github.invalid/mcp",
          auth: "none",
          headerKeys: []
        }
      })
      yield* rules.save(settings({ subject: push, list: lab, decision: "ask" }))
      const overrides = (name: string) => allowIsOverridden(rules, tool(name), lab)
      expect({
        spaceAsk: yield* overrides("space_ask"),
        spaceNever: yield* overrides("space_never"),
        globalAsk: yield* overrides("global_ask"),
        globalAllow: yield* overrides("global_allow"),
        otherSpace: yield* overrides("other_space"),
        none: yield* overrides("unruled"),
        commandAsk: yield* allowIsOverridden(rules, push, lab),
        commandElsewhere: yield* allowIsOverridden(rules, push, jobs),
        connectorNone: yield* allowIsOverridden(rules, github, lab)
      }).toEqual({
        spaceAsk: true,
        spaceNever: true,
        globalAsk: true,
        globalAllow: false,
        otherSpace: false,
        none: false,
        commandAsk: true,
        commandElsewhere: false,
        connectorNone: false
      })
    })
  )
})

it("a connector's allow never lands over the person's global ask or never on one of its tools", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const rules = yield* PermissionRules
      const mcp = yield* McpStore
      const lab = {
        kind: "space",
        spaceId: (yield* (yield* SpaceStore).create({ name: "Lab" })).space_id
      } as const
      for (const name of ["github", "linear", "notion", "slack"])
        yield* mcp.create({
          name,
          enabled: true,
          presetId: null,
          transport: {
            type: "http",
            url: `https://${name}.invalid/mcp`,
            auth: "none",
            headerKeys: []
          }
        })
      yield* rules.save(
        settings({
          subject: { kind: "tool", tool: "mcp__github__merge", server: "github" },
          list: { kind: "global" },
          decision: "ask"
        })
      )
      yield* rules.save(
        settings({
          subject: { kind: "tool", tool: "mcp__notion__delete", server: "notion" },
          list: { kind: "global" },
          decision: "never"
        })
      )
      yield* rules.save(
        settings({
          subject: { kind: "tool", tool: "mcp__linear__read", server: "linear" },
          list: { kind: "global" },
          decision: "allow"
        })
      )
      yield* rules.save(
        settings({
          subject: { kind: "connector", server: "slack" },
          list: { kind: "global" },
          decision: "ask"
        })
      )
      const connector = (server: string, list: RuleInput["list"]) =>
        allowIsOverridden(rules, { kind: "connector", server }, list)
      expect({
        globalAsk: yield* connector("github", lab),
        globalNever: yield* connector("notion", lab),
        globalAllow: yield* connector("linear", lab),
        everywhere: yield* connector("github", { kind: "global" }),
        toolUnderConnectorAsk: yield* allowIsOverridden(
          rules,
          { kind: "tool", tool: "mcp__slack__post", server: "slack" },
          lab
        )
      }).toEqual({
        globalAsk: true,
        globalNever: true,
        globalAllow: false,
        everywhere: false,
        toolUnderConnectorAsk: true
      })
    })
  )
})

it("a connector tool's rule is saved only with its server, and goes when the server goes", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const rules = yield* PermissionRules
      const mcp = yield* McpStore
      const runpod = { kind: "tool", tool: "mcp__runpod__list", server: "runpod" } as const
      const missing = yield* rules
        .save(settings({ subject: runpod, list: { kind: "global" }, decision: "allow" }))
        .pipe(Effect.result)
      expect(missing).toMatchObject({ _tag: "Failure", failure: { reason: "not_found" } })
      yield* mcp.create({
        name: "runpod",
        enabled: true,
        presetId: null,
        transport: { type: "http", url: "https://runpod.invalid/mcp", auth: "none", headerKeys: [] }
      })
      yield* rules.save(settings({ subject: runpod, list: { kind: "global" }, decision: "allow" }))
      expect((yield* rules.list()).map(({ subject }) => subject)).toEqual([runpod])
      yield* mcp.remove("runpod")
      expect(yield* rules.list()).toEqual([])
    })
  )
})

it.each([
  [
    "a Space card, as asked",
    "space:lab",
    { kind: "space", spaceId: "lab" },
    undefined,
    { kind: "space", spaceId: "lab" }
  ],
  [
    "a Space card, picked Everywhere",
    "space:lab",
    { kind: "space", spaceId: "lab" },
    "global",
    { kind: "global" }
  ],
  [
    "a card whose run left its Space",
    "space:lab",
    { kind: "space", spaceId: "jobs" },
    undefined,
    undefined
  ],
  ["a card outside a Space", "global", { kind: "global" }, undefined, { kind: "global" }],
  ["a card outside a Space, picked This Space", "global", { kind: "global" }, "space", undefined],
  ["a built-in job's card", "system", { kind: "system" }, undefined, { kind: "system" }],
  [
    "a built-in job's card, picked Everywhere",
    "system",
    { kind: "system" },
    "global",
    { kind: "global" }
  ],
  [
    "an old command card, as asked",
    "command:global",
    { kind: "space", spaceId: "lab" },
    undefined,
    { kind: "global" }
  ],
  [
    "an old command card, picked This Space",
    "command:global",
    { kind: "space", spaceId: "lab" },
    "space",
    undefined
  ],
  ["a card whose run is gone", "global", undefined, undefined, undefined]
] as const)("%s saves to its list", (_case, asked, now, picked, saved) => {
  expect(cardRuleList({ asked, now, picked })).toEqual(saved)
})

it("a folder rule allows or never, and no allow opens home or a secret", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const rules = yield* PermissionRules
      const global = { kind: "global" } as const
      const folder = (path: string) => ({ kind: "path", path, access: "change" }) as const
      const refused = (input: Omit<RuleInput, "source">) =>
        rules.save(settings(input)).pipe(Effect.result)
      expect(
        yield* refused({ subject: folder(homedir()), list: global, decision: "allow" })
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid" }
      })
      expect(
        yield* refused({
          subject: folder(path.join(homedir(), ".ssh")),
          list: global,
          decision: "allow"
        })
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid" } })
      expect(
        yield* refused({ subject: folder("/Users/me/src/demo"), list: global, decision: "ask" })
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid" } })
      const never = yield* rules.save(
        settings({ subject: folder(homedir()), list: global, decision: "never" })
      )
      expect(never.subject).toEqual(folder(homedir()))
      const allowed = yield* rules.save(
        settings({ subject: folder("/Users/me/src/demo"), list: global, decision: "allow" })
      )
      const loosened = yield* rules
        .change({ ruleId: never.id, decision: "allow", source: { kind: "settings" } })
        .pipe(Effect.result)
      expect(loosened).toMatchObject({ _tag: "Failure" })
      expect(allowed.decision).toBe("allow")
    })
  )
})

it("saves words with their hard rules, and removing or recompiling the words replaces them", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const rules = yield* PermissionRules
      const global = { kind: "global" } as const
      const documents = { kind: "path", path: "/Users/me/Documents", access: "read" } as const
      const words = yield* rules.saveWords({
        text: "never touch Documents",
        list: global,
        decision: "never",
        rules: [{ subject: documents, decision: "never" }],
        source: { kind: "settings" }
      })
      const shape = () =>
        rules
          .list()
          .pipe(
            Effect.map((all) =>
              all.map(({ subject, decision, fromRuleId }) => ({ subject, decision, fromRuleId }))
            )
          )
      expect(yield* shape()).toEqual(
        expect.arrayContaining([
          {
            subject: { kind: "words", text: "never touch Documents" },
            decision: "never",
            fromRuleId: null
          },
          { subject: documents, decision: "never", fromRuleId: words.id }
        ])
      )
      yield* rules.saveWords({
        text: "never touch Documents",
        list: global,
        decision: "never",
        rules: [],
        source: { kind: "settings" }
      })
      expect(yield* shape()).toEqual([
        {
          subject: { kind: "words", text: "never touch Documents" },
          decision: "never",
          fromRuleId: null
        }
      ])
      yield* rules.saveWords({
        text: "never touch Documents",
        list: global,
        decision: "never",
        rules: [{ subject: documents, decision: "never" }],
        source: { kind: "settings" }
      })
      yield* rules.change({ ruleId: words.id, decision: "remove", source: { kind: "settings" } })
      expect(yield* shape()).toEqual([])
    })
  )
})

it("words never change or take over a rule the owner set", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const rules = yield* PermissionRules
      const global = { kind: "global" } as const
      const documents = { kind: "path", path: "/Users/me/Documents", access: "read" } as const
      const own = yield* rules.save({
        subject: documents,
        list: global,
        decision: "never",
        source: { kind: "settings" }
      })
      const words = yield* rules.saveWords({
        text: "read my Documents",
        list: global,
        decision: "allow",
        rules: [{ subject: documents, decision: "allow" }],
        source: { kind: "settings" }
      })
      const replaced = yield* rules
        .saveWords({
          text: "anything",
          list: global,
          decision: "allow",
          rules: [],
          replaces: own.id,
          source: { kind: "settings" }
        })
        .pipe(Effect.result)
      expect(replaced).toMatchObject({ _tag: "Failure" })
      yield* rules.change({ ruleId: words.id, decision: "remove", source: { kind: "settings" } })
      const left = yield* rules.list()
      expect(left.map(({ id, decision, fromRuleId }) => ({ id, decision, fromRuleId }))).toEqual([
        { id: own.id, decision: "never", fromRuleId: null }
      ])
    })
  )
})

it("a words rule's new decision reaches the hard rules it compiled to", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const rules = yield* PermissionRules
      const global = { kind: "global" } as const
      const folder = { kind: "path", path: "/Users/me/src/resume", access: "change" } as const
      const command = { kind: "command", executable: "git", argumentPrefix: ["push"] } as const
      const words = yield* rules.saveWords({
        text: "changing my resume and pushing it",
        list: global,
        decision: "allow",
        rules: [
          { subject: folder, decision: "allow" },
          { subject: command, decision: "allow" }
        ],
        source: { kind: "settings" }
      })
      const children = () =>
        rules
          .list()
          .pipe(
            Effect.map((all) =>
              all
                .filter((rule) => rule.fromRuleId === words.id)
                .map(({ subject, decision }) => ({ kind: subject.kind, decision }))
            )
          )
      yield* rules.change({ ruleId: words.id, decision: "never", source: { kind: "settings" } })
      expect(yield* children()).toEqual(
        expect.arrayContaining([
          { kind: "path", decision: "never" },
          { kind: "command", decision: "never" }
        ])
      )
      yield* rules.change({ ruleId: words.id, decision: "ask", source: { kind: "settings" } })
      expect(yield* children()).toEqual([{ kind: "command", decision: "ask" }])
    })
  )
})
