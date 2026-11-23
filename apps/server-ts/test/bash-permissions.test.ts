import { ROLE } from "@arden-hq/std/message-vocabulary"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import { PermissionRules } from "../src/persistence/permissions/rules.js"
import type { CommandPolicyRule } from "../src/persistence/permissions/command-policy.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { parseCommandSegments, planHostCommandGrant } from "../src/tools/bash-permissions.js"
import { ToolHistoryQueries } from "../src/persistence/tools/history-queries.js"

const executable = async (directory: string, name: string): Promise<string> => {
  const filename = join(directory, name)
  await writeFile(filename, "#!/bin/sh\nexit 0\n", "utf8")
  await chmod(filename, 0o755)
  return filename
}

const allowing =
  (rules: ReadonlyArray<CommandPolicyRule>) =>
  (segment: { readonly executable: string; readonly arguments: ReadonlyArray<string> }) =>
    rules.some(
      (rule) =>
        rule.executable_path === segment.executable &&
        rule.argument_prefix.every((part, index) => segment.arguments[index] === part)
    )
      ? ("allow" as const)
      : undefined

const savedCommands = Effect.gen(function* () {
  const rules = yield* PermissionRules
  return (yield* rules.list()).flatMap((rule) =>
    rule.subject.kind === "command" && rule.decision === "allow" && rule.list.kind === "global"
      ? [
          {
            executable: rule.subject.executable,
            argumentPrefix: rule.subject.argumentPrefix
          }
        ]
      : []
  )
})

describe("bash permissions", () => {
  it("parses literal command chains and rejects ambiguous shell syntax", () => {
    expect(parseCommandSegments("prime list && git status --short")).toEqual([
      ["prime", "list"],
      ["git", "status", "--short"]
    ])
    expect(parseCommandSegments("prime '$HOME'")).toEqual([["prime", "$HOME"]])
    expect(parseCommandSegments("prime $HOME")).toBeUndefined()
    expect(parseCommandSegments("prime list > result.txt")).toBeUndefined()
    expect(parseCommandSegments("prime list & git status")).toBeUndefined()
  })

  it("reads an assignment that keeps the command's own value as no change, and refuses any other", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-bash-assign-"))
    const bin = join(directory, "bin")
    await mkdir(bin)
    await executable(bin, "gh")
    const environment = { PATH: bin, GH_PAGER: "cat", NO_COLOR: "1" }
    try {
      const plan = await planHostCommandGrant({
        command:
          "GH_PAGER=cat NO_COLOR=1 gh auth status && GH_PAGER=cat gh api repos/o/r --jq '.sha'",
        cwd: directory,
        environment,
        rule: () => undefined
      })
      if (plan.offer === undefined) throw new Error("expected reusable gh rules")
      expect(plan.offer.rules.map((rule) => rule.argument_prefix)).toEqual([
        ["auth", "status"],
        ["api"]
      ])
      const authOnly = plan.offer.rules.filter((rule) => rule.argument_prefix[0] === "auth")
      expect(
        (
          await planHostCommandGrant({
            command: "GH_PAGER=cat gh auth status",
            cwd: directory,
            environment,
            rule: allowing(plan.offer.rules)
          })
        ).rule
      ).toBe("allow")
      expect(
        (
          await planHostCommandGrant({
            command: "gh auth status && gh api repos/o/r",
            cwd: directory,
            environment,
            rule: allowing(authOnly)
          })
        ).rule
      ).toBeUndefined()
      const api = await planHostCommandGrant({
        command:
          "gh api 'repos/openai/codex/commits?path=codex-rs/startup.rs&per_page=30' --jq '.[] | .sha'",
        cwd: directory,
        environment,
        rule: () => undefined
      })
      expect(api.offer?.rules.map((rule) => rule.argument_prefix)).toEqual([["api"]])
      const flagged = await planHostCommandGrant({
        command: "gh run --repo o/r list",
        cwd: directory,
        environment,
        rule: () => undefined
      })
      expect([flagged.rule, flagged.offer]).toEqual([undefined, undefined])
      const executablePath = api.offer?.rules[0]?.executable_path ?? ""
      expect(
        await planHostCommandGrant({
          command: "gh api repos/o/r --jq '.sha'",
          cwd: directory,
          environment,
          rule: allowing([
            {
              executable_path: executablePath,
              argument_prefix: ["api", "repos/o/r"],
              display_prefix: "gh api repos/o/r …"
            }
          ])
        })
      ).toMatchObject({ rule: "allow" })
      for (const command of [
        "GH_PAGER=less gh auth status",
        "GH_TOKEN=x gh auth status",
        `PATH=${directory} gh auth status`
      ]) {
        const refused = await planHostCommandGrant({
          command,
          cwd: directory,
          environment,
          rule: allowing(plan.offer.rules)
        })
        expect([refused.rule, refused.offer]).toEqual([undefined, undefined])
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("scopes multi-purpose CLIs by subcommand and never offers interpreters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-bash-prefix-"))
    const bin = join(directory, "bin")
    await mkdir(bin)
    await Promise.all([executable(bin, "git"), executable(bin, "python3")])
    const environment = { PATH: bin }

    try {
      const git = await planHostCommandGrant({
        command: "git status --short",
        cwd: directory,
        environment,
        rule: () => undefined
      })
      expect(git).toMatchObject({
        offer: {
          rules: [{ argument_prefix: ["status"], display_prefix: "git status …" }]
        }
      })

      const interpreter = await planHostCommandGrant({
        command: "python3 script.py",
        cwd: directory,
        environment,
        rule: () => undefined
      })
      expect(interpreter).toEqual({ rule: undefined, displayPrefixes: [] })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("settles Always allow consistently with SQL rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-bash-settlement-"))
    const layer = sqlitePersistenceLayer({
      dataDir: null,
      filename: join(directory, "arden.db")
    }).pipe(Layer.provide(PersistenceWriteQueue.layer))
    const offer = {
      rules: [
        {
          executable_path: "/usr/local/bin/prime",
          argument_prefix: [],
          display_prefix: "prime …"
        }
      ]
    }

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const chat = yield* ChatWriteStore
          const sessions = yield* SessionStore
          const tools = yield* ToolExecutionStore
          const toolHistory = yield* ToolHistoryQueries
          const session = yield* sessions.create({ name: "Bash settlement" })
          const started = yield* chat.start({
            sessionId: session.sessionId,
            clientId: "client-bash-settlement",
            requestHash: "hash-bash-settlement",
            assistantMessageId: "assistant-bash-settlement",
            message: {
              message_id: "client-bash-settlement",
              client_id: "client-bash-settlement",
              role: ROLE.user,
              content: "Use Prime",
              created_at: "2026-08-31T00:00:00.000Z"
            }
          })
          if (started._tag !== "Started") return yield* Effect.die("chat run did not start")
          const identity = {
            runId: started.runId,
            sessionId: session.sessionId,
            toolCallId: "bash-prime",
            toolName: "exec_command",
            arguments: { command: "prime pods list" },
            changesState: true
          } as const
          yield* tools.begin(identity)
          yield* tools.pause(identity, {
            reason: "approval",
            data: {
              working_directory: directory,
              access: "host",
              command_grant: offer
            }
          })
          const pending = yield* toolHistory.pendingApprovals(session.sessionId)
          const database = new DatabaseSync(join(directory, "arden.db"))
          try {
            database.exec(`CREATE TRIGGER reject_bash_approval BEFORE UPDATE ON tool_approvals
                BEGIN SELECT RAISE(ABORT, 'injected approval settlement failure'); END`)
          } finally {
            database.close()
          }
          const settled = yield* tools
            .resolve({
              runId: started.runId,
              toolCallId: identity.toolCallId,
              approved: true,
              grantStanding: true,
              grantList: "global"
            })
            .pipe(Effect.result)
          expect(settled).toMatchObject({
            _tag: "Failure",
            failure: { operation: "resolve", reason: "storage" }
          })
          expect(yield* toolHistory.pendingApprovals(session.sessionId)).toEqual(pending)
          expect(yield* savedCommands).toEqual([])
          return pending
        }).pipe(Effect.provide(layer))
      )

      expect(result).toMatchObject([{ rule_places: [{ kind: "space" }, { kind: "everywhere" }] }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
