import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { runCli, type CliClient, type CliDependencies } from "../src/index.js"
import type { AppLauncher, InstalledApp } from "../src/app-launch.js"
import { HeadlessHttpError } from "@arden-hq/headless"

import {
  cancelling,
  emit,
  completedRun,
  defaultClient,
  jsonLines,
  listedSession,
  runEvent,
  type RunDetail
} from "./kit.js"
import { CAPABILITY, URL_ARGS, started, testIo } from "./cli-kit.js"

const accessFile = (pid = 4242): string =>
  JSON.stringify({ version: 1, serverUrl: "http://127.0.0.1:51234/", capability: CAPABILITY, pid })

describe("arden run", () => {
  it("reads stdin, creates an unnamed chat, and emits one JSON receipt", async () => {
    let submittedPrompt = ""
    let created: unknown
    const client: CliClient = {
      ...defaultClient(),
      createSession: async (input) => {
        created = input
        return defaultClient().createSession(input)
      },
      submit: async (input) => {
        submittedPrompt = input.message
        return defaultClient().submit(input)
      },
      wait: async (run, options) => {
        await emit(options, runEvent("RUN_STARTED"))
        return { ...completedRun(), run_id: run.runId, session_id: run.sessionId }
      }
    }
    const io = testIo({
      client,
      env: { ARDEN_URL: "http://arden.test" },
      stdin: { kind: "pipe", text: "  Prompt from stdin\n" }
    })

    const exitCode = await runCli(["run", "--output", "json"], io.dependencies)
    expect(exitCode).toBe(0)
    expect(jsonLines(io.stdout())).toEqual([
      expect.objectContaining({
        version: 1,
        type: "command_receipt",
        status: "completed",
        run_id: "run-1",
        session_id: "session-1",
        result: expect.objectContaining({ text: "Final answer" }),
        declined: []
      })
    ])
    expect(created).toEqual({
      name: { kind: "unnamed" },
      space: { kind: "none" },
      chat_model: { kind: "inherited" },
      origin: "ordinary"
    })
    expect(submittedPrompt).toBe("Prompt from stdin")
  })

  it("cancels the submitted Run on SIGINT and emits one interrupted receipt", async () => {
    let finishWait: (() => void) | undefined
    let markWaitStarted: () => void = () => undefined
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve
    })
    const cancellations: Array<unknown> = []
    const client: CliClient = {
      ...defaultClient(),
      wait: async () => {
        markWaitStarted()
        return new Promise<RunDetail>((resolve) => {
          finishWait = () => resolve(completedRun())
        })
      },
      cancel: async (input) => {
        cancellations.push(input)
        return cancelling(input)
      }
    }
    const io = testIo({ client })
    const execution = runCli(
      ["run", "Prompt", ...URL_ARGS, "--session", "session-1", "--output", "json"],
      io.dependencies
    )

    await waitStarted
    io.sigint()
    finishWait?.()
    const exitCode = await execution
    const receipts = jsonLines(io.stdout())

    expect(exitCode).toBe(130)
    expect(cancellations).toEqual([{ kind: "run", runId: "run-1" }])
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      type: "command_receipt",
      status: "interrupted",
      exit_code: 130
    })
  })

  it("rejects conflicting chat choices before contacting Arden", async () => {
    for (const args of [
      ["--session", "s-1", "--continue"],
      ["--fork", "s-1", "--space", "Finance"],
      ["--detach", "--timeout", "5"]
    ]) {
      const io = testIo()
      expect(await runCli(["run", "Prompt", ...URL_ARGS, ...args], io.dependencies)).toBe(2)
      expect(io.connections()).toEqual([])
    }
  })

  it("finds an arden serve on the default settings when the app is not running", async () => {
    const files = { "/home/test/.arden-cli/data/cli-access.json": accessFile() }
    const io = testIo({ files })
    expect(await runCli(["run", "Prompt", "--output", "json"], io.dependencies)).toBe(0)
    expect(io.connections()).toEqual([
      { url: "http://127.0.0.1:51234/", headers: { "x-arden-local-capability": CAPABILITY } }
    ])
    const elsewhere = testIo({ files, env: { ARDEN_DIR: "/elsewhere" } })
    expect(await runCli(["run", "Prompt", "--output", "json"], elsewhere.dependencies)).toBe(1)
    expect(elsewhere.connections()).toEqual([])
  })
})

describe("an Arden older than the CLI", () => {
  const refusing = (status: number): CliClient => ({
    ...defaultClient(),
    submit: async () => {
      throw new HeadlessHttpError(status, "POST", "/chat/message", "")
    },
    listSessions: async () => {
      throw new HeadlessHttpError(500, "GET", "/sessions", "")
    }
  })

  it("reports an Arden that refuses the mode as server_outdated", async () => {
    const json = testIo({ client: refusing(403) })
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS, "--output", "json"], json.dependencies)
    ).toBe(1)
    expect(jsonLines(json.stdout())[0]).toMatchObject({
      error: { code: "server_outdated" }
    })
  })
})

describe("starting the installed app", () => {
  const appAccess = "/home/test/.arden/cli-access.json"
  const launching = (
    onOpen: (files: Map<string, string>) => void,
    kind: InstalledApp["kind"] = "background"
  ) => {
    const files = new Map<string, string>()
    const opened: Array<string> = []
    const launcher: AppLauncher = {
      find: async () => ({ kind, path: "/Applications/Arden.app" }),
      open: async (appPath) => {
        opened.push(appPath)
        onOpen(files)
      },
      pollMs: 1,
      timeoutMs: 50
    }
    const readFile = async (path: string): Promise<Uint8Array> => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return Buffer.from(text)
    }
    return { files, opened, launcher, readFile }
  }

  it("starts Arden in the background and sends the prompt to it, never a server of its own", async () => {
    const app = launching((files) => files.set(appAccess, accessFile(4242)))
    app.files.set(appAccess, accessFile(99))
    const events: Array<string> = []
    const io = testIo({ launcher: app.launcher, alive: (pid) => pid !== 99 })
    expect(
      await runCli(["hey", "--output", "json"], {
        ...io.dependencies,
        ...started(events),
        readFile: app.readFile
      })
    ).toBe(0)
    expect(app.opened).toEqual(["/Applications/Arden.app"])
    expect(events).toEqual([])
    expect(io.connections()).toEqual([
      { url: "http://127.0.0.1:51234/", headers: { "x-arden-local-capability": CAPABILITY } }
    ])
    expect(io.stderr()).toBe("arden: Arden is not running; starting it in the background.\n")
  })

  it("says Arden did not start when no live access file appears", async () => {
    const app = launching(() => undefined)
    const io = testIo({ launcher: app.launcher })
    expect(
      await runCli(["run", "Prompt", "--output", "json"], {
        ...io.dependencies,
        readFile: app.readFile
      })
    ).toBe(1)
    expect(jsonLines(io.stdout())[0]).toMatchObject({
      error: {
        code: "server_unavailable",
        message: `Arden did not start within 0 s: ${appAccess} names no running server`
      }
    })
  })

  it("never starts an Arden too old to start in the background", async () => {
    const app = launching(() => undefined, "too_old")
    const events: Array<string> = []
    const io = testIo({ launcher: app.launcher })
    const dependencies = { ...io.dependencies, ...started(events), readFile: app.readFile }
    expect(await runCli(["sessions"], dependencies)).toBe(1)
    const home = await mkdtemp(join(tmpdir(), "arden-cli-home-"))
    try {
      expect(await runCli(["hey"], { ...dependencies, homeDirectory: home })).toBe(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
    expect(app.opened).toEqual([])
    expect(events).toEqual([`start ${join(home, ".arden-cli", "settings.json")} -`, "stop"])
    expect(io.stderr()).toBe(
      [
        "arden: Arden is not running, and the installed Arden is too old to start from the command line. Open Arden, or update it.",
        "arden: The installed Arden is too old to start in the background; this prompt runs on a server of its own, without your accounts.",
        ""
      ].join("\n")
    )
  })
})

describe("arden login", () => {
  it("signs in through the browser, says so, and signs out", async () => {
    const home = await mkdtemp(join(tmpdir(), "arden-cli-home-"))
    try {
      const opened: Array<string> = []
      const io = testIo()
      const dependencies: CliDependencies = {
        ...io.dependencies,
        homeDirectory: home,
        openUrl: (url) => opened.push(url),
        startLogin: async () => ({
          url: "https://auth.test/oauth/authorize?state=s",
          tokens: Promise.resolve({
            access: "access",
            refresh: "refresh",
            expires: 1_800_000_000_000,
            accountId: "account-1"
          }),
          cancel: () => undefined
        })
      }
      expect(await runCli(["login", "--status"], dependencies)).toBe(1)
      expect(await runCli(["login"], dependencies)).toBe(0)
      expect(opened).toEqual(["https://auth.test/oauth/authorize?state=s"])
      const file = join(home, ".arden-cli", "chatgpt-login.json")
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(await runCli(["login", "--status"], dependencies)).toBe(0)
      expect(await runCli(["logout"], dependencies)).toBe(0)
      expect(await runCli(["login", "--status"], dependencies)).toBe(1)
      expect(io.stdout()).toBe(
        [
          "Not signed in. Run `arden login`.",
          "Signed in with ChatGPT.",
          "Signed in with ChatGPT.",
          "Signed out.",
          "Not signed in. Run `arden login`.",
          ""
        ].join("\n")
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("no empty chat is left behind", () => {
  it("removes the chat it created when the message is refused, only while it is still empty", async () => {
    for (const [messageCount, active] of [
      [0, false],
      [1, false],
      [0, true]
    ] as const) {
      const deleted: Array<string> = []
      const client: CliClient = {
        ...defaultClient(),
        submit: async () => {
          throw new HeadlessHttpError(422, "POST", "/chat/message", "")
        },
        listSessions: async () => ({
          sessions: [
            {
              ...listedSession(messageCount),
              run: active
                ? { kind: "active", run_id: "run-1", turn_id: "turn-1", status: "running" }
                : { kind: "none" }
            }
          ],
          next: { kind: "end" }
        }),
        deleteSession: async (sessionId) => {
          deleted.push(sessionId)
        }
      }
      const io = testIo({ client })

      expect(await runCli(["run", "Prompt", ...URL_ARGS], io.dependencies)).toBe(1)
      expect(deleted).toEqual(messageCount === 0 && !active ? ["session-1"] : [])
    }
  })

  it("keeps the chat it created once the message was accepted, even if the Run then fails", async () => {
    const deleted: Array<string> = []
    const client: CliClient = {
      ...defaultClient(),
      wait: async () => {
        throw new Error("lost the connection")
      },
      listSessions: async () => ({ sessions: [listedSession(0)], next: { kind: "end" } }),
      deleteSession: async (sessionId) => {
        deleted.push(sessionId)
      }
    }
    const io = testIo({ client })

    expect(await runCli(["run", "Prompt", ...URL_ARGS], io.dependencies)).toBe(1)
    expect(deleted).toEqual([])
  })

  it("never removes a chat it was pointed at", async () => {
    const deleted: Array<string> = []
    const client: CliClient = {
      ...defaultClient(),
      submit: async () => {
        throw new HeadlessHttpError(503, "POST", "/chat/message", "")
      },
      listSessions: async () => ({ sessions: [listedSession(0)], next: { kind: "end" } }),
      deleteSession: async (sessionId) => {
        deleted.push(sessionId)
      }
    }
    const io = testIo({ client })

    expect(
      await runCli(["run", "Prompt", ...URL_ARGS, "--session", "session-1"], io.dependencies)
    ).toBe(1)
    expect(deleted).toEqual([])
  })
})
