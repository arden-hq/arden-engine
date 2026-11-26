import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runCli, type CliClient } from "../src/index.js"

import {
  approvalNeeded,
  cancelling,
  emit,
  completedRun,
  defaultClient,
  jsonLines,
  type RunDetail
} from "./kit.js"
import { ASKED_AT, CAPABILITY, URL_ARGS, started, testIo } from "./cli-kit.js"

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
    const card = approvalNeeded("tool-1")
    const io = testIo({
      client: {
        ...approvalClient(answers),
        wait: async (_run, options) => {
          await emit(options, {
            ...card,
            data: { ...card.data, asked: { kind: "recorded", at: ASKED_AT } }
          })
          await emit(options, {
            ...card,
            data: { ...card.data, asked: { kind: "recorded", at: ASKED_AT } }
          })
          await emit(options, approvalNeeded("tool-9", "run-other"))
          return completedRun()
        }
      }
    })

    const exitCode = await runCli(
      ["run", "Prompt", ...URL_ARGS, "--no-wait-approval", "--output", "json"],
      io.dependencies
    )

    expect(exitCode).toBe(0)
    expect(answers).toEqual([
      expect.objectContaining({
        runId: "run-1",
        toolId: "tool-1",
        decision: { kind: "denied", grant: { kind: "once" } },
        asked: { kind: "at", at: ASKED_AT }
      })
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
    expect(modes).toEqual(
      ["safe", "read_only", "ask", "allow"].map((mode) => ({ kind: "mode", mode }))
    )
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
    expect(io.connections()).toEqual([
      { url: "http://127.0.0.1:51234/", headers: { "x-arden-local-capability": CAPABILITY } }
    ])
    expect(jsonLines(io.stdout())).toMatchObject([
      { type: "command_receipt", command: "run", status: "completed", exit_code: 0 }
    ])
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
      createSession: async (input) => {
        created.push(input)
        return defaultClient().createSession(input)
      }
    }
    const listed = testIo({ client })
    expect(
      await runCli(["run", "hi", ...URL_ARGS, "--model", "gemma-4"], listed.dependencies)
    ).toBe(0)
    expect(created).toMatchObject([{ chat_model: { kind: "pinned", model_id: "gemma-4" } }])

    const other = testIo({ client })
    expect(
      await runCli(
        ["run", "hi", ...URL_ARGS, "--model", "gpt-6-sol", "--output", "json"],
        other.dependencies
      )
    ).toBe(2)
    expect(created).toMatchObject([{ chat_model: { kind: "pinned", model_id: "gemma-4" } }])
    expect(jsonLines(other.stdout())[0]).toMatchObject({
      status: "failed",
      exit_code: 2,
      session_id: null,
      error: { code: "invalid_input" }
    })
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
