import { NO_PATH_RULES } from "./fixtures/local-policy.js"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { describe, expect, it } from "vitest"

import { mentionsArdenData } from "../src/tools/arden-data-mention.js"
import { cardRuleSubjects } from "../src/persistence/sqlite/permissions.js"
import {
  approvalPrompt,
  sandboxDenialNote,
  commandGrantPlan,
  withHelperRule,
  commandSkipsCard,
  shellRuntime,
  type ResolvedShell
} from "../src/tools/shell-policy.js"

const host: ResolvedShell = {
  cwd: "/Users/me/project",
  access: "host",
  codeAgent: false,
  policy: {
    cwd: "/Users/me/project",
    readRoots: null,
    writeRoot: null,
    stateRoot: "/nonexistent/arden-state",
    sandbox: "host_approved",
    pathRules: NO_PATH_RULES
  }
}

describe("host command approval", () => {
  it("asks the user in every mode with Always ask on, and follows the mode with it off", () => {
    const modes: ReadonlyArray<ChatApprovalMode> = ["ask", "safe", "allow"]
    const table = (alwaysAsk: boolean, readsOnly: boolean) =>
      Object.fromEntries(
        modes.map((mode) => [
          mode,
          commandSkipsCard({
            access: "host",
            mode,
            alwaysAsk,
            readsOnly,
            codeAgent: false,
            ardenData: false
          })
            ? "runs"
            : "card"
        ])
      )
    expect({
      on: table(true, false),
      "on, read-only": table(true, true),
      off: table(false, false),
      "off, read-only": table(false, true)
    }).toEqual({
      on: { ask: "card", safe: "card", allow: "card" },
      "on, read-only": { ask: "card", safe: "card", allow: "card" },
      off: { ask: "card", safe: "card", allow: "runs" },
      "off, read-only": { ask: "runs", safe: "runs", allow: "runs" }
    })
    expect(
      commandSkipsCard({
        access: "host",
        mode: "safe",
        alwaysAsk: false,
        readsOnly: true,
        codeAgent: false,
        ardenData: true
      })
    ).toBe(false)
  })

  it("runs a sandboxed command, and sends a network escalation through the mode like host access", () => {
    const modes: ReadonlyArray<ChatApprovalMode> = ["ask", "safe", "allow"]
    const table = (access: "sandbox" | "network", codeAgent: boolean, alwaysAsk: boolean) =>
      Object.fromEntries(
        modes.map((mode) => [
          mode,
          commandSkipsCard({
            access,
            mode,
            alwaysAsk,
            readsOnly: true,
            codeAgent,
            ardenData: false
          })
            ? "runs"
            : "card"
        ])
      )
    expect({
      sandbox: table("sandbox", true, true),
      "network, code agent": table("network", true, false),
      "network, chat": table("network", false, false),
      "network, Always ask": table("network", true, true)
    }).toEqual({
      sandbox: { ask: "runs", safe: "runs", allow: "runs" },
      "network, code agent": { ask: "card", safe: "card", allow: "runs" },
      "network, chat": { ask: "card", safe: "card", allow: "runs" },
      "network, Always ask": { ask: "card", safe: "card", allow: "card" }
    })
    expect(
      commandSkipsCard({
        access: "host",
        mode: "safe",
        alwaysAsk: false,
        readsOnly: true,
        codeAgent: true,
        ardenData: false
      })
    ).toBe(false)
  })

  it("tells the Helper and the user the command has no sandbox, and marks an Always-ask card as the user's", () => {
    const helperCard = approvalPrompt({
      command: "rm -rf ~/.arden",
      resolved: host,
      ardenData: true
    })
    expect(helperCard.presentation?.fields).toEqual(
      expect.arrayContaining([
        { label: "Access", value: "Full access to files, network and processes" },
        { label: "Warning", value: "This command can change Arden's own data." }
      ])
    )
    expect(helperCard.data?.["reviewer"]).not.toBe("user")
    const plain = approvalPrompt({ command: "make", resolved: host, ardenData: false })
    expect(plain.presentation?.fields.map((field) => field.label)).not.toContain("Warning")
    expect(
      approvalPrompt({ command: "make", resolved: host, ardenData: false, userOnly: true }).data?.[
        "reviewer"
      ]
    ).toBe("user")
  })
})

describe("sandbox denial note", () => {
  it("points a refused connection at the network escalation, and other refusals at the sandbox", () => {
    const sandboxed = {
      cwd: "/w",
      readRoots: null,
      writeRoot: "/w",
      stateRoot: "/nonexistent/arden-state",
      sandbox: "code_agent" as const,
      pathRules: NO_PATH_RULES
    }
    const kind = (stderr: string, network = false) =>
      sandboxDenialNote({ ...sandboxed, network }, stderr)
    const networkNote = kind("curl: (6) Could not resolve host: example.com")
    expect(networkNote).toBeDefined()
    expect(kind("curl: (7) Failed to connect to 10.0.0.5 port 443: Connection refused")).toBe(
      networkNote
    )
    const fileNote = kind("cat: .ssh/id: Operation not permitted")
    expect(fileNote).toBeDefined()
    expect(fileNote).not.toBe(networkNote)
    expect(kind("curl: (7) Failed to connect: Connection refused", true)).toBeUndefined()
    expect(kind("ordinary failure")).toBeUndefined()
  })
})

describe("Arden data mention", () => {
  const roots = ["/Users/me/.arden", "/Volumes/Data/arden-state"]
  const mentions = (command: string, cwd = "/Users/me/project") =>
    mentionsArdenData({ command, cwd, roots, home: "/Users/me" })

  it("finds Arden's data folder in the usual spellings", () => {
    expect(
      [
        "rm -rf ~/.arden/arden.db",
        'ls "$HOME"/.arden',
        "cat ${HOME}/.arden/settings.json",
        "sqlite3 '/Users/me/.arden/arden.db' .tables",
        "du -sh /Volumes/Data/arden-state",
        "cp x ~/.ARDEN/",
        "ls ~/.arden*"
      ].filter((command) => !mentions(command))
    ).toEqual([])
    expect(mentions("rm -rf .arden", "/Users/me")).toBe(true)
    expect(mentions("ls", "/Users/me/.arden/skills")).toBe(true)
  })

  it("does not flag other paths that only look alike", () => {
    expect(
      [
        "git status",
        "ls ~/.arden-old",
        "cat ~/.arden.bak",
        "cat project/.arden.yml",
        "ls /tmp/Users/me/.ardenx"
      ].filter((command) => mentions(command))
    ).toEqual([])
  })

  it("offers and honors command rules for a code agent too", async () => {
    const codeAgent: ResolvedShell = { ...host, codeAgent: true }
    const runtime = shellRuntime({ environment: { PATH: "/bin:/usr/bin" }, loginPath: undefined })
    const none = { own: undefined, rules: [] }
    const offered = await commandGrantPlan(none, "ls -la", codeAgent, runtime)
    expect(offered?.offer?.rules.map((rule) => rule.display_prefix)).toEqual(["ls …"])
    const rule = offered?.offer?.rules[0]
    if (rule === undefined) throw new Error("expected an offer")
    const saved = {
      own: undefined,
      rules: [
        {
          id: "rule-1",
          subject: {
            kind: "command" as const,
            executable: rule.executable_path,
            argumentPrefix: rule.argument_prefix
          },
          list: { kind: "global" as const },
          decision: "allow" as const,
          source: { kind: "settings" as const, runId: null },
          createdAt: null,
          fromRuleId: null
        }
      ]
    }
    expect((await commandGrantPlan(saved, "ls -la", codeAgent, runtime))?.rule).toBe("allow")
  })

  it("keeps a Helper-judged card's Always allow as words, never as a command rule", async () => {
    const runtime = shellRuntime({ environment: { PATH: "/bin:/usr/bin" }, loginPath: undefined })
    const plan = await commandGrantPlan({ own: undefined, rules: [] }, "ls -la", host, runtime)
    const prompt = approvalPrompt({ command: "ls -la", resolved: host, plan, ardenData: false })
    expect(
      cardRuleSubjects({ toolName: "exec_command", serverName: undefined, data: prompt.data })
    ).toMatchObject([{ kind: "command" }])
    const judged = withHelperRule(prompt, "list files  in Lab")
    expect(judged.data).not.toHaveProperty("command_grant")
    expect(
      cardRuleSubjects({ toolName: "exec_command", serverName: undefined, data: judged.data })
    ).toEqual([{ kind: "words", text: "list files in Lab" }])
  })
})
