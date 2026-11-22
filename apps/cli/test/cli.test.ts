import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runCli, type CliClient, type CliDependencies } from "../src/index.js"
import type { AppLauncher, InstalledApp } from "../src/app-launch.js"
import type { StdinKind } from "../src/command.js"
import { HeadlessHttpError, type HeadlessRunEvent } from "@arden-hq/headless"
import type { RunQuestion } from "@arden-hq/protocol/runs"

import {
  approvalNeeded,
  catalogEntry,
  cancelling,
  emit,
  completedRun,
  defaultClient,
  jsonLines,
  listedSession,
  runEvent,
  type RunDetail
} from "./kit.js"

interface TestIo {
  readonly dependencies: CliDependencies
  readonly stdout: () => string
  readonly stderr: () => string
  readonly sigint: () => void
  readonly connections: () => ReadonlyArray<{ readonly url: string; readonly headers: unknown }>
}

const testIo = (
  input: {
    readonly client?: CliClient
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly stdin?: { readonly kind: StdinKind; readonly text: string }
    readonly files?: Readonly<Record<string, string>>
    readonly alive?: (pid: number) => boolean
    readonly launcher?: AppLauncher
  } = {}
): TestIo => {
  let stdout = ""
  let stderr = ""
  let sigintListener: (() => void) | undefined
  const connections: Array<{ readonly url: string; readonly headers: unknown }> = []
  const dependencies: CliDependencies = {
    env: input.env ?? {},
    homeDirectory: "/home/test",
    stdin: input.stdin?.kind ?? "terminal",
    readStdin: async () => input.stdin?.text ?? "",
    readFile: async (path) => {
      const text = input.files?.[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return Buffer.from(text)
    },
    isProcessAlive: input.alive ?? (() => true),
    appLauncher: input.launcher ?? NO_APP,
    writeStdout: (value) => {
      stdout += value
    },
    writeStderr: (value) => {
      stderr += value
    },
    onSigint: (listener) => {
      sigintListener = listener
      return () => {
        if (sigintListener === listener) sigintListener = undefined
      }
    },
    createClient: (connection) => {
      connections.push({ url: connection.url.href, headers: connection.headers })
      return input.client ?? defaultClient()
    }
  }
  return {
    dependencies,
    stdout: () => stdout,
    stderr: () => stderr,
    sigint: () => sigintListener?.(),
    connections: () => connections
  }
}

const NO_APP: AppLauncher = {
  find: async () => undefined,
  open: async () => {
    throw new Error("the tests never open an app")
  },
  pollMs: 1,
  timeoutMs: 20
}

const URL_ARGS = ["--url", "http://arden.test"] as const

const ASKED_AT = "2026-11-21T22:11:50.941Z"

const APP_ONLY = "Only the Arden app can allow this."
const UNCHECKED =
  "Arden could not check whether this can be allowed from here, so it cannot be allowed here. If this keeps happening, update Arden."
const CAPABILITY = "c".repeat(43)
const accessFile = (pid = 4242): string =>
  JSON.stringify({ version: 1, serverUrl: "http://127.0.0.1:51234/", capability: CAPABILITY, pid })

describe("arden run", () => {
  it("reads stdin, creates an unnamed chat, and emits one JSON receipt", async () => {
    let submittedPrompt = ""
    let created: unknown
    const client: CliClient = {
      ...defaultClient(),
      createSession: async (input = {}) => {
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
    expect(created).toEqual({})
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
    expect(cancellations).toEqual([{ runId: "run-1" }])
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

  it("says to update Arden when it refuses the mode, and never prints an HTTP status", async () => {
    const io = testIo({ client: refusing(403) })
    expect(await runCli(["run", "Prompt", ...URL_ARGS], io.dependencies)).toBe(1)
    expect(await runCli(["run", "Prompt", ...URL_ARGS, "--mode", "ask"], io.dependencies)).toBe(1)
    expect(await runCli(["sessions", ...URL_ARGS], io.dependencies)).toBe(1)
    expect(io.stderr()).toBe(
      [
        "arden: This Arden is older than the CLI. Update Arden, or add --mode ask.",
        "arden: Arden does not let the command line do this.",
        "arden: Arden hit an error. Try again, or look at its log.",
        ""
      ].join("\n")
    )
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

  it("leaves the app alone when ARDEN_DIR names another data folder", async () => {
    const app = launching(() => undefined)
    const io = testIo({ launcher: app.launcher, env: { ARDEN_DIR: "/elsewhere" } })
    expect(await runCli(["run", "Prompt", "--output", "json"], io.dependencies)).toBe(1)
    expect(app.opened).toEqual([])
  })
})

describe("arden <prompt>", () => {
  const withHome = async (run: (home: string) => Promise<void>): Promise<void> => {
    const home = await mkdtemp(join(tmpdir(), "arden-cli-home-"))
    try {
      await run(home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }

  it("sends to a running Arden, else runs the prompt on a server of its own", () =>
    withHome(async (home) => {
      const events: Array<string> = []
      const running = testIo({ files: { "/home/test/.arden/cli-access.json": accessFile() } })
      expect(
        await runCli(["Say hello", "--output", "json"], {
          ...running.dependencies,
          ...started(events)
        })
      ).toBe(0)
      expect(events).toEqual([])
      expect(running.connections()).toHaveLength(1)
      const idle = testIo()
      expect(
        await runCli(["Say", "hello", "--output", "json"], {
          ...idle.dependencies,
          ...started(events),
          homeDirectory: home
        })
      ).toBe(0)
      expect(events).toEqual([`start ${join(home, ".arden-cli", "settings.json")} -`, "stop"])
      expect(jsonLines(idle.stdout())).toMatchObject([{ status: "completed" }])
    }))

  it("takes one word as the prompt, and refuses a detached Run with nothing running", async () => {
    const events: Array<string> = []
    const running = testIo({ files: { "/home/test/.arden/cli-access.json": accessFile() } })
    expect(await runCli(["hey"], running.dependencies)).toBe(0)
    expect(running.stdout()).toBe("Final answer\n")
    const io = testIo()
    const dependencies = { ...io.dependencies, ...started(events) }
    expect(await runCli(["Say hello", "--detach", "--output", "json"], dependencies)).toBe(2)
    expect(events).toEqual([])
    expect(jsonLines(io.stdout())).toMatchObject([
      { error: { code: "invalid_input", message: expect.stringContaining("arden serve") } }
    ])
  })
})

const QUESTION: RunQuestion = {
  question_id: "question-1",
  run_id: "run-1",
  turn_id: "turn-1",
  session_id: "session-1",
  destination_session_id: "session-1",
  context: { origin: { kind: "chat", session_id: "session-1", turn_id: "turn-1" }, task: null },
  content: {
    prompt: "Which inbox?",
    detail: null,
    choices: [
      { id: "work", label: "Work" },
      { id: "home", label: "Home" }
    ]
  },
  status: "open",
  resolution: null,
  continuation: null,
  focus_choice: null,
  permission_offer: null,
  continuity_revision: null,
  created_at: "2026-08-30T00:00:00.000Z"
}

const QUESTION_EVENT: HeadlessRunEvent = {
  event: "TOOL_CALL_RESULT",
  data: {
    type: "TOOL_CALL_RESULT",
    tool_call_id: "call-ask",
    name: "ask_user",
    run_id: "run-1",
    session_id: "session-1",
    data: { question: QUESTION }
  }
}

describe("progress and asks at a terminal", () => {
  const askingWith = (answers: Array<string>) => {
    const prompts: Array<string> = []
    return {
      prompts,
      askInTerminal: async (prompt: string) => {
        prompts.push(prompt)
        return answers.shift()
      }
    }
  }

  it("names each tool call and prints no start or end noise", async () => {
    const client: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, runEvent("RUN_STARTED"))
        await emit(options, {
          event: "TOOL_CALL_START",
          data: {
            type: "TOOL_CALL_START",
            tool_call_id: "call-1",
            tool_call_name: "gmail_search",
            display_name: "Gmail",
            display_title: "Search inbox"
          }
        })
        await emit(options, {
          event: "TOOL_CALL_END",
          data: { type: "TOOL_CALL_END", tool_call_id: "call-1" }
        })
        await emit(options, {
          event: "TOOL_CALL_START",
          data: {
            type: "TOOL_CALL_START",
            tool_call_id: "call-2",
            tool_call_name: "exec_command",
            display_name: "Command"
          }
        })
        await emit(options, {
          event: "TOOL_CALL_ARGS",
          data: { type: "TOOL_CALL_ARGS", tool_call_id: "call-2", delta: '{"command":' }
        })
        await emit(options, {
          event: "TOOL_CALL_ARGS",
          data: { type: "TOOL_CALL_ARGS", tool_call_id: "call-2", delta: '"ls -la"}' }
        })
        await emit(options, {
          event: "TOOL_CALL_END",
          data: { type: "TOOL_CALL_END", tool_call_id: "call-2" }
        })
        await emit(options, runEvent("RUN_FINISHED"))
        return completedRun()
      }
    }
    const io = testIo({ client })
    expect(await runCli(["run", "Prompt", ...URL_ARGS], io.dependencies)).toBe(0)
    expect(io.stderr()).toBe("arden: Gmail · Search inbox\narden: Command · ls -la\n")
  })

  it("asks for an approval and a connection, and answers with the choice", async () => {
    const approvals: Array<unknown> = []
    const connections: Array<unknown> = []
    const client: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, {
          ...approvalNeeded("tool-1"),
          data: {
            ...approvalNeeded("tool-1").data,
            rule_places: [{ kind: "everywhere" }]
          }
        })
        await emit(options, {
          event: "connection_needed",
          data: {
            type: "connection_needed",
            run_id: "run-1",
            tool_id: "tool-2",
            integration_id: "google",
            connection_id: "connection-1",
            label: "Gmail",
            reason: "not_configured",
            detail: "Gmail is not connected.",
            capability: "gmail.read",
            action: "oauth",
            settings_tab: "connections",
            required_scopes: [],
            source: "recovery"
          }
        })
        return completedRun()
      },
      answerApproval: async (input) => {
        approvals.push(input)
      },
      answerConnection: async (input) => {
        connections.push(input)
      }
    }
    const io = testIo({ client })
    const asking = askingWith(["4", "2", "2"])
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    expect(asking.prompts).toEqual([
      "Arden asks to run write_file.\n  1) Allow once\n  2) Always allow\n  3) Deny\nChoose 1-3: ",
      "Type a number from 1 to 3: ",
      "Arden needs Gmail connected: Gmail is not connected.\n  1) I connected it in Arden, go on\n  2) Skip it\nChoose 1-2: "
    ])
    expect(approvals).toEqual([
      { runId: "run-1", toolId: "tool-1", result: "", approved: true, grantStanding: true }
    ])
    expect(connections).toEqual([
      { runId: "run-1", toolId: "tool-2", connectionId: "connection-1", approved: false }
    ])
  })

  it("answers a card with the asking it names, and a card that names none without one", async () => {
    const approvals: Array<unknown> = []
    const card = approvalNeeded("tool-1")
    const client: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, { ...card, data: { ...card.data, asked_at: ASKED_AT } })
        await emit(options, approvalNeeded("tool-2"))
        return completedRun()
      },
      answerApproval: async (input) => {
        approvals.push(input)
      }
    }
    const io = testIo({ client })
    const asking = askingWith(["1", "2"])
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    expect(approvals).toEqual([
      {
        runId: "run-1",
        toolId: "tool-1",
        result: "",
        approved: true,
        grantStanding: false,
        askedAt: ASKED_AT
      },
      { runId: "run-1", toolId: "tool-2", result: "", approved: false, grantStanding: false }
    ])
  })

  it("offers no grant of a card only the Arden app grants; it can deny it or leave it waiting", async () => {
    const approvals: Array<unknown> = []
    const pay = (toolId: string): HeadlessRunEvent => ({
      event: "approval_needed",
      data: { ...approvalNeeded(toolId).data, name: "vault_pay" }
    })
    const client: CliClient = {
      ...defaultClient(),
      toolCatalog: async () => ({
        tools: [catalogEntry("vault_pay", { card: "vault_card_pay" })],
        unlisted: {}
      }),
      wait: async (_run, options) => {
        await emit(options, pay("pay-1"))
        await emit(options, pay("pay-2"))
        await emit(options, pay("pay-1"))
        return completedRun()
      },
      answerApproval: async (input) => {
        approvals.push(input)
      }
    }
    const io = testIo({ client })
    const asking = askingWith(["1", "2"])
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    const card = `Arden asks to run vault_pay. ${APP_ONLY}\n  1) Deny\n  2) Leave it waiting\nChoose 1-2: `
    expect(asking.prompts).toEqual([card, card])
    expect(approvals).toEqual([
      { runId: "run-1", toolId: "pay-1", result: "", approved: false, grantStanding: false }
    ])
    expect(io.stderr()).toBe("arden: Deny: vault_pay\narden: vault_pay stays waiting.\n")
  })

  it("a catalog that could not be read leaves the card unknown, and is read again at the next card", async () => {
    const prompts: Array<string> = []
    let reads = 0
    const pay = (toolId: string): HeadlessRunEvent => ({
      event: "approval_needed",
      data: { ...approvalNeeded(toolId).data, name: "vault_pay" }
    })
    const client: CliClient = {
      ...defaultClient(),
      toolCatalog: async () => {
        reads += 1
        if (reads === 1) throw new Error("the server was busy")
        return { tools: [catalogEntry("vault_pay", { card: "vault_card_pay" })], unlisted: {} }
      },
      wait: async (_run, options) => {
        await emit(options, pay("pay-1"))
        await emit(options, pay("pay-2"))
        await emit(options, pay("pay-3"))
        return completedRun()
      }
    }
    const io = testIo({ client })
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: async (prompt) => {
          prompts.push(prompt.split("\n")[0] ?? "")
          return undefined
        }
      })
    ).toBe(0)
    expect(prompts).toEqual([
      `Arden asks to run vault_pay. ${UNCHECKED}`,
      `Arden asks to run vault_pay. ${APP_ONLY}`,
      `Arden asks to run vault_pay. ${APP_ONLY}`
    ])
    expect(reads).toBe(2)
  })

  it("a tool the catalog did not list is looked up again at its next card", async () => {
    const prompts: Array<string> = []
    let reads = 0
    const later = (toolId: string): HeadlessRunEvent => ({
      event: "approval_needed",
      data: { ...approvalNeeded(toolId).data, name: "mcp_search" }
    })
    const client: CliClient = {
      ...defaultClient(),
      toolCatalog: async () => {
        reads += 1
        return {
          tools: reads === 1 ? [] : [catalogEntry("mcp_search", {})],
          unlisted: {}
        }
      },
      wait: async (_run, options) => {
        await emit(options, later("search-1"))
        await emit(options, later("search-2"))
        return completedRun()
      }
    }
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...testIo({ client }).dependencies,
        askInTerminal: async (prompt) => {
          prompts.push(prompt)
          return undefined
        }
      })
    ).toBe(0)
    expect(prompts.map((prompt) => prompt.split("\n").at(-2))).toEqual([
      "  2) Leave it waiting",
      "  2) Deny"
    ])
    expect(reads).toBe(2)
  })

  it.each([
    ["a prompt sent to the running Arden app", ["Prompt"], true],
    ["arden run against a server named by --url", ["run", "Prompt", ...URL_ARGS], false],
    ["arden wait against a server named by --url", ["wait", "run-1", ...URL_ARGS], false],
    ["arden exec on a server of its own", ["exec", "--config", "s.json", "Prompt"], false]
  ] as const)("%s says the same about a card it may not allow", async (_entry, argv, app) => {
    const pay: HeadlessRunEvent = {
      event: "approval_needed",
      data: { ...approvalNeeded("pay-1").data, name: "vault_pay" }
    }
    const client: CliClient = {
      ...defaultClient(),
      toolCatalog: async () => ({
        tools: [catalogEntry("vault_pay", { card: "vault_card_pay" })],
        unlisted: {}
      }),
      wait: async (_run, options) => {
        await emit(options, pay)
        return completedRun()
      },
      waitForRun: async (_runId, options) => {
        await emit(options, pay)
        return completedRun()
      }
    }
    const events: Array<string> = []
    const io = testIo({
      client,
      ...(app ? { files: { "/home/test/.arden/cli-access.json": accessFile() } } : {})
    })
    const asking = askingWith(["2"])
    expect(
      await runCli([...argv], {
        ...io.dependencies,
        ...started(events),
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    expect(asking.prompts).toEqual([
      `Arden asks to run vault_pay. ${APP_ONLY}\n  1) Deny\n  2) Leave it waiting\nChoose 1-2: `
    ])
    expect(io.stderr()).toBe("arden: vault_pay stays waiting.\n")
  })

  it("a server that will not show its catalog, or a tool it does not list, gets no grant from here", async () => {
    const approvals: Array<unknown> = []
    const listedNowhere: HeadlessRunEvent = {
      event: "approval_needed",
      data: { ...approvalNeeded("tool-2").data, name: "unlisted_tool" }
    }
    const refusing: CliClient = {
      ...defaultClient(),
      toolCatalog: async () => {
        throw new HeadlessHttpError(403, "GET", "/tools", "")
      },
      wait: async (_run, options) => {
        await emit(options, approvalNeeded("tool-1"))
        return completedRun()
      },
      answerApproval: async (input) => {
        approvals.push(input)
      }
    }
    const asking = askingWith(["1"])
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...testIo({ client: refusing }).dependencies,
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    expect(asking.prompts).toEqual([
      `Arden asks to run write_file. ${UNCHECKED}\n  1) Deny\n  2) Leave it waiting\nChoose 1-2: `
    ])
    expect(approvals).toEqual([
      { runId: "run-1", toolId: "tool-1", result: "", approved: false, grantStanding: false }
    ])

    const missing: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, listedNowhere)
        return completedRun()
      }
    }
    const leaving = askingWith(["2"])
    const io = testIo({ client: missing })
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: leaving.askInTerminal
      })
    ).toBe(0)
    expect(leaving.prompts[0]?.endsWith("1) Deny\n  2) Leave it waiting\nChoose 1-2: ")).toBe(true)
    expect(io.stderr()).toBe("arden: unlisted_tool stays waiting.\n")
  })

  it("with no one to ask, no catalog is read; a stalled read ends with the wait", async () => {
    let reads = 0
    const unattended: CliClient = {
      ...defaultClient(),
      toolCatalog: async () => {
        reads += 1
        return { tools: [], unlisted: {} }
      },
      wait: async (_run, options) => {
        await emit(options, approvalNeeded("tool-1"))
        return completedRun()
      }
    }
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], testIo({ client: unattended }).dependencies)
    ).toBe(0)
    expect(reads).toBe(0)

    const stalled: CliClient = {
      ...defaultClient(),
      toolCatalog: async (options) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true
          })
        }),
      wait: async (_run, options) => {
        await emit(options, approvalNeeded("tool-1"))
        return completedRun()
      }
    }
    const io = testIo({ client: stalled })
    const running = runCli(["run", "Prompt", ...URL_ARGS], {
      ...io.dependencies,
      askInTerminal: async () => "1"
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    io.sigint()
    expect(await running).not.toBe(0)
    expect(io.stderr()).toBe("arden: Interrupted by SIGINT\n")
  })

  it("names the tool as progress does, and declines on its own server when the terminal ends", async () => {
    const commandStart: HeadlessRunEvent = {
      event: "TOOL_CALL_START",
      data: {
        type: "TOOL_CALL_START",
        tool_call_id: "tool-1",
        tool_call_name: "write_file",
        display_name: "Write file"
      }
    }
    const answers: Array<unknown> = []
    const client: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, commandStart)
        await emit(options, approvalNeeded("tool-1"))
        return completedRun()
      },
      answerApproval: async (input) => {
        answers.push(input)
      }
    }
    const allowing = testIo({ client })
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...allowing.dependencies,
        askInTerminal: askingWith(["1"]).askInTerminal
      })
    ).toBe(0)
    expect(allowing.stderr()).toBe("arden: Allow once: Write file\n")
    const waiting = testIo({ client })
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...waiting.dependencies,
        askInTerminal: askingWith([]).askInTerminal
      })
    ).toBe(0)
    expect(waiting.stderr()).toBe(
      "arden: Write file waits for an answer in Arden. To decline instead, run again with --no-wait-approval.\n"
    )
    const events: Array<string> = []
    const own = testIo({ client })
    expect(
      await runCli(["exec", "--config", "s.json", "Prompt"], {
        ...own.dependencies,
        ...started(events),
        askInTerminal: askingWith([]).askInTerminal
      })
    ).toBe(0)
    expect(own.stderr()).toBe("arden: declined Write file: no one is here to answer it\n")
    expect(answers.at(-1)).toMatchObject({ toolId: "tool-1", approved: false })
  })

  it("says how to answer when no one is at a terminal", async () => {
    const client: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, approvalNeeded("tool-1"))
        return completedRun()
      }
    }
    const io = testIo({ client })
    expect(await runCli(["run", "Prompt", ...URL_ARGS], io.dependencies)).toBe(0)
    expect(io.stderr()).toBe(
      "arden: write_file waits for an answer in Arden. To decline instead, run again with --no-wait-approval.\n"
    )
  })

  it("answers a question and follows the Run the answer starts", async () => {
    const answered: Array<unknown> = []
    const followed: Array<string> = []
    const client: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, QUESTION_EVENT)
        return completedRun("Asked")
      },
      answerQuestion: async (questionId, input) => {
        answered.push({ questionId, answer: input.answer })
        return {
          ...QUESTION,
          continuation: { kind: "started", run_id: "run-2", at: "2026-08-30T00:00:02.000Z" }
        }
      },
      waitForRun: async (runId) => {
        followed.push(runId)
        return completedRun("Work inbox: 3 unread")
      }
    }
    const io = testIo({ client })
    const asking = askingWith(["1"])
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    expect(asking.prompts).toEqual([
      "Arden asks: Which inbox?\n  1) Work\n  2) Home\n  3) Answer later in Arden\nChoose 1-3: "
    ])
    expect(answered).toEqual([
      { questionId: "question-1", answer: { kind: "choice", choice_id: "work" } }
    ])
    expect(followed).toEqual(["run-2"])
    expect(io.stdout()).toBe("Work inbox: 3 unread\n")
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
    for (const messageCount of [0, 1]) {
      const deleted: Array<string> = []
      const client: CliClient = {
        ...defaultClient(),
        submit: async () => {
          throw new HeadlessHttpError(422, "POST", "/chat/message", "")
        },
        listSessions: async () => ({ sessions: [listedSession(messageCount)], next_cursor: null }),
        deleteSession: async (sessionId) => {
          deleted.push(sessionId)
        }
      }
      const io = testIo({ client })

      expect(await runCli(["run", "Prompt", ...URL_ARGS], io.dependencies)).toBe(1)
      expect(deleted).toEqual(messageCount === 0 ? ["session-1"] : [])
    }
  })

  it("never removes a chat it was pointed at", async () => {
    const deleted: Array<string> = []
    const client: CliClient = {
      ...defaultClient(),
      submit: async () => {
        throw new HeadlessHttpError(503, "POST", "/chat/message", "")
      },
      listSessions: async () => ({ sessions: [listedSession(0)], next_cursor: null }),
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

describe("approvals with no one at the terminal", () => {
  const approvalClient = (answers: Array<unknown>): CliClient => ({
    ...defaultClient(),
    wait: async (_run, options) => {
      await emit(options, approvalNeeded("tool-1"))
      await emit(options, approvalNeeded("tool-1"))
      await emit(options, approvalNeeded("tool-9", "run-other"))
      return completedRun()
    },
    answerApproval: async (input) => {
      answers.push(input)
    }
  })

  it("--no-wait-approval declines this Run's request once and records it", async () => {
    const answers: Array<unknown> = []
    const io = testIo({ client: approvalClient(answers) })

    const exitCode = await runCli(
      ["run", "Prompt", ...URL_ARGS, "--no-wait-approval", "--output", "json"],
      io.dependencies
    )

    expect(exitCode).toBe(0)
    expect(answers).toEqual([
      expect.objectContaining({ runId: "run-1", toolId: "tool-1", approved: false })
    ])
    expect(jsonLines(io.stdout())[0]).toMatchObject({
      declined: [{ kind: "approval", tool_id: "tool-1", name: "write_file" }]
    })
  })

  it("--no-wait-approval declines the asking the card names", async () => {
    const answers: Array<unknown> = []
    const card = approvalNeeded("tool-1")
    const client: CliClient = {
      ...approvalClient(answers),
      wait: async (_run, options) => {
        await emit(options, { ...card, data: { ...card.data, asked_at: ASKED_AT } })
        return completedRun()
      }
    }
    const io = testIo({ client })

    expect(
      await runCli(["run", "Prompt", ...URL_ARGS, "--no-wait-approval"], io.dependencies)
    ).toBe(0)
    expect(answers).toEqual([
      expect.objectContaining({ toolId: "tool-1", approved: false, askedAt: ASKED_AT })
    ])
  })

  it("by default leaves the request to Arden and answers nothing", async () => {
    const answers: Array<unknown> = []
    const io = testIo({ client: approvalClient(answers) })

    expect(await runCli(["run", "Prompt", ...URL_ARGS], io.dependencies)).toBe(0)
    expect(answers).toEqual([])
  })

  it("sends the app's mode for --mode, Auto when none is given", async () => {
    const modes: Array<unknown> = []
    const client: CliClient = {
      ...defaultClient(),
      submit: async (input) => {
        modes.push(input.approvalMode)
        return defaultClient().submit(input)
      }
    }
    const io = testIo({ client })
    for (const flags of [[], ["--mode", "read-only"], ["--mode", "ask"], ["--mode=never-ask"]]) {
      expect(await runCli(["run", "Prompt", ...URL_ARGS, ...flags], io.dependencies)).toBe(0)
    }
    expect(modes).toEqual(["safe", "read_only", "ask", "allow"])
    const refused = testIo({ client })
    expect(
      await runCli(
        ["run", "Prompt", ...URL_ARGS, "--mode", "yolo", "--output", "json"],
        refused.dependencies
      )
    ).toBe(2)
    expect(jsonLines(refused.stdout())[0]).toMatchObject({
      error: { code: "invalid_input", message: "--mode must be read-only, ask, auto, never-ask" }
    })
  })

  it("declines an approval on a server of its own when no one is at a terminal", async () => {
    const answers: Array<unknown> = []
    const events: Array<string> = []
    const client: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, approvalNeeded("tool-1"))
        return completedRun()
      },
      answerApproval: async (input) => {
        answers.push(input)
      }
    }
    const io = testIo({ client })
    expect(
      await runCli(["exec", "--config", "s.json", "Prompt"], {
        ...io.dependencies,
        ...started(events)
      })
    ).toBe(0)
    expect(answers).toEqual([
      expect.objectContaining({ runId: "run-1", toolId: "tool-1", approved: false })
    ])
    expect(io.stderr()).toBe("arden: declined write_file: no one is here to answer it\n")
  })
})

describe("finding the running app", () => {
  const accessPath = "/home/test/.arden/cli-access.json"

  it("says Arden is not running when there is no file, or its process is gone", async () => {
    for (const io of [
      testIo(),
      testIo({ files: { [accessPath]: accessFile(99) }, alive: (pid) => pid !== 99 })
    ]) {
      expect(await runCli(["run", "Prompt", "--output", "json"], io.dependencies)).toBe(1)
      expect(jsonLines(io.stdout())[0]).toMatchObject({
        status: "failed",
        error: { code: "server_unavailable", message: expect.stringContaining("not running") }
      })
      expect(io.connections()).toEqual([])
    }
  })
})

describe("arden wait", () => {
  it("follows an existing Run without cancelling it on SIGINT", async () => {
    const cancellations: Array<unknown> = []
    let markWaitStarted: () => void = () => undefined
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve
    })
    const client: CliClient = {
      ...defaultClient(),
      waitForRun: async (_runId, options) => {
        markWaitStarted()
        return new Promise<RunDetail>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason))
        })
      },
      cancel: async (input) => {
        cancellations.push(input)
        return cancelling(input)
      }
    }
    const io = testIo({ client })
    const execution = runCli(["wait", "run-1", ...URL_ARGS, "--output", "json"], io.dependencies)

    await waitStarted
    io.sigint()

    expect(await execution).toBe(130)
    expect(cancellations).toEqual([])
    expect(jsonLines(io.stdout())[0]).toMatchObject({
      command: "wait",
      status: "interrupted",
      run_id: "run-1"
    })
  })
})

const started = (events: Array<string>) => ({
  startServer: async (input: { readonly config: string; readonly logFile: string | undefined }) => {
    events.push(`start ${input.config} ${input.logFile ?? "-"}`)
    return {
      connection: {
        url: new URL("http://127.0.0.1:51234/"),
        headers: { "x-arden-local-capability": CAPABILITY }
      },
      stop: async () => {
        events.push("stop")
      }
    }
  }
})

describe("arden exec", () => {
  it("starts the configured server, runs the prompt on it and stops it", async () => {
    const events: Array<string> = []
    const io = testIo()
    const code = await runCli(
      ["exec", "--config", "settings.json", "--server-log", "server.log", "--output", "json", "hi"],
      { ...io.dependencies, ...started(events) }
    )
    expect(code).toBe(0)
    expect(events).toEqual(["start settings.json server.log", "stop"])
    // It reaches the server it started, with that server's own secret.
    expect(io.connections()).toEqual([
      { url: "http://127.0.0.1:51234/", headers: { "x-arden-local-capability": CAPABILITY } }
    ])
    expect(jsonLines(io.stdout())).toMatchObject([
      { type: "command_receipt", command: "run", status: "completed", exit_code: 0 }
    ])
  })

  it("writes and uses a default settings file without --config", async () => {
    const home = await mkdtemp(join(tmpdir(), "arden-cli-home-"))
    try {
      const events: Array<string> = []
      const io = testIo()
      const dependencies = { ...io.dependencies, ...started(events), homeDirectory: home }
      expect(await runCli(["exec", "--output", "json", "hi"], dependencies)).toBe(0)
      expect(await runCli(["exec", "--output", "json", "hi"], dependencies)).toBe(0)
      const file = join(home, ".arden-cli", "settings.json")
      expect(events).toEqual([`start ${file} -`, "stop", `start ${file} -`, "stop"])
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        dataDirectory: join(home, ".arden-cli", "data")
      })
      expect((await stat(join(home, ".arden-cli"))).mode & 0o777).toBe(0o700)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("starts no server for a prompt it cannot send", async () => {
    const events: Array<string> = []
    const io = testIo()
    expect(
      await runCli(["exec", "--config", "settings.json", "--output", "json"], {
        ...io.dependencies,
        ...started(events)
      })
    ).toBe(2)
    expect(events).toEqual([])
    expect(await runCli(["exec", "--config", "s.json", "--detach", "hi"], io.dependencies)).toBe(2)
    expect(jsonLines(io.stdout())).toMatchObject([{ error: { code: "invalid_input" } }])
  })

  it("reports a server that did not start, and stops the server when the Run fails", async () => {
    const io = testIo()
    expect(
      await runCli(["exec", "--config", "settings.json", "--output", "json", "hi"], {
        ...io.dependencies,
        startServer: async () => {
          throw new Error("Invalid settings: `dataDirectory` is missing")
        }
      })
    ).toBe(1)
    expect(jsonLines(io.stdout())).toMatchObject([
      { status: "failed", error: { message: "Invalid settings: `dataDirectory` is missing" } }
    ])

    const events: Array<string> = []
    const failing = testIo({
      client: {
        ...defaultClient(),
        submit: async () => {
          throw new Error("the model is gone")
        }
      }
    })
    expect(
      await runCli(["exec", "--config", "settings.json", "--output", "json", "hi"], {
        ...failing.dependencies,
        ...started(events)
      })
    ).toBe(1)
    expect(events).toEqual(["start settings.json -", "stop"])
  })
})

describe("arden exec on a server that does not start", () => {
  let directory = ""
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "arden-cli-exec-"))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  // A real process stands in for the server's `main.js --config`, exiting as the server does.
  it("tells a settings mistake, a model server that is down and a failed start apart", async () => {
    const receipts: Array<unknown> = []
    for (const [code, said] of [
      [2, "Missing environment variable KEY, named by `provider.apiKeyEnv`"],
      [3, "The model server at http://127.0.0.1:9/v1 (`provider.baseUrl`) did not answer"],
      [1, "Database is locked"]
    ] as const) {
      const entry = join(directory, `exit-${code}.mjs`)
      await writeFile(
        entry,
        `console.error(${JSON.stringify(`arden: ${said}`)}); process.exit(${code})`
      )
      const io = testIo({ env: { ARDEN_SERVER_ENTRY: entry } })
      const exitCode = await runCli(
        ["exec", "--config", "settings.json", "--output", "json", "hi"],
        io.dependencies
      )
      const [receipt] = jsonLines(io.stdout())
      receipts.push({ exitCode, receipt })
    }
    expect(receipts).toMatchObject([
      {
        exitCode: 2,
        receipt: {
          exit_code: 2,
          error: {
            code: "invalid_input",
            message: "Missing environment variable KEY, named by `provider.apiKeyEnv`"
          }
        }
      },
      {
        exitCode: 3,
        receipt: {
          exit_code: 3,
          error: {
            code: "provider_unavailable",
            message: "The model server at http://127.0.0.1:9/v1 (`provider.baseUrl`) did not answer"
          }
        }
      },
      {
        exitCode: 1,
        receipt: {
          exit_code: 1,
          error: { code: "server_unavailable", message: "Database is locked" }
        }
      }
    ])
  })
})

describe("the model a Run runs on", () => {
  it("lists the server's models by the ids --model takes", async () => {
    const text = testIo()
    expect(await runCli(["models", ...URL_ARGS], text.dependencies)).toBe(0)
    expect(text.stdout()).toBe("gemma-4  llama.cpp  efforts: none, medium\n")

    const json = testIo()
    expect(await runCli(["models", ...URL_ARGS, "--output", "json"], json.dependencies)).toBe(0)
    expect(jsonLines(json.stdout())).toEqual([
      {
        version: 1,
        type: "model_list",
        providers: [
          {
            id: "llama.cpp",
            name: "llama.cpp",
            models: [{ id: "gemma-4", name: "gemma-4", reasoningEfforts: ["none", "medium"] }]
          }
        ]
      }
    ])
  })

  it("starts a chat on a listed model, and names the listed ones for any other", async () => {
    const created: Array<unknown> = []
    const client: CliClient = {
      ...defaultClient(),
      createSession: async (input = {}) => {
        created.push(input)
        return defaultClient().createSession(input)
      }
    }
    const listed = testIo({ client })
    expect(
      await runCli(["run", "hi", ...URL_ARGS, "--model", "gemma-4"], listed.dependencies)
    ).toBe(0)
    expect(created).toEqual([{ chat_model: "gemma-4" }])

    const other = testIo({ client })
    expect(
      await runCli(
        ["run", "hi", ...URL_ARGS, "--model", "gpt-6-sol", "--output", "json"],
        other.dependencies
      )
    ).toBe(2)
    expect(created).toEqual([{ chat_model: "gemma-4" }])
    expect(jsonLines(other.stdout())).toEqual([
      {
        version: 1,
        type: "command_receipt",
        command: "run",
        status: "failed",
        exit_code: 2,
        run_id: null,
        session_id: null,
        client_id: null,
        run_status: null,
        model_id: null,
        reasoning_effort: null,
        result: null,
        error: {
          code: "invalid_input",
          message: "This server has no model gpt-6-sol. It lists: gemma-4"
        },
        declined: []
      }
    ])
  })

  it("says which model answered, with the server's usage and cost as sent", async () => {
    const io = testIo()
    expect(await runCli(["run", "hi", ...URL_ARGS, "--output", "json"], io.dependencies)).toBe(0)
    expect(jsonLines(io.stdout())).toEqual([
      {
        version: 1,
        type: "command_receipt",
        command: "run",
        status: "completed",
        exit_code: 0,
        run_id: "run-1",
        session_id: "session-1",
        client_id: "client-1",
        run_status: "completed",
        model_id: "fixture-model",
        reasoning_effort: null,
        result: completedRun().result,
        error: null,
        declined: []
      }
    ])
  })

  it("refuses a prompt longer than one message takes before reaching the server", async () => {
    const io = testIo({ stdin: { kind: "pipe", text: "x".repeat(100_001) } })
    expect(await runCli(["run", ...URL_ARGS, "--output", "json"], io.dependencies)).toBe(2)
    expect(io.connections()).toEqual([])
    expect(jsonLines(io.stdout())).toMatchObject([
      {
        error: {
          code: "invalid_input",
          message: "The prompt is 100001 characters; one message takes at most 100000"
        }
      }
    ])
  })
})
