import { describe, expect, it } from "vitest"

import { runCli, type CliClient, type CliDependencies } from "../src/index.js"
import type { StdinKind } from "../src/command.js"
import { HeadlessHttpError } from "@arden-hq/headless"

import {
  approvalNeeded,
  cancelling,
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
  } = {}
): TestIo => {
  let stdout = ""
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
    writeStdout: (value) => {
      stdout += value
    },
    writeStderr: () => {},
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
    sigint: () => sigintListener?.(),
    connections: () => connections
  }
}

const URL_ARGS = ["--url", "http://arden.test"] as const
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
        await options?.onEvent?.(runEvent("RUN_STARTED"))
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
      await options?.onEvent?.(approvalNeeded("tool-1"))
      await options?.onEvent?.(approvalNeeded("tool-1"))
      await options?.onEvent?.(approvalNeeded("tool-9", "run-other"))
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

  it("by default leaves the request to Arden and answers nothing", async () => {
    const answers: Array<unknown> = []
    const io = testIo({ client: approvalClient(answers) })

    expect(await runCli(["run", "Prompt", ...URL_ARGS], io.dependencies)).toBe(0)
    expect(answers).toEqual([])
  })

  it("passes the approval mode with the message", async () => {
    let mode: unknown
    const client: CliClient = {
      ...defaultClient(),
      submit: async (input) => {
        mode = input.approvalMode
        return defaultClient().submit(input)
      }
    }
    const io = testIo({ client })

    expect(
      await runCli(["run", "Prompt", ...URL_ARGS, "--approval", "read_only"], io.dependencies)
    ).toBe(0)
    expect(mode).toBe("read_only")
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
