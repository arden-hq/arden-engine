import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import {
  closeMcpClient,
  connectMcpClient,
  makeMcpClient,
  McpTimeoutError
} from "../src/mcp/client.js"
import {
  classifyMcpStartFailure,
  McpStartFailure,
  type McpFailureReason
} from "../src/mcp/failure.js"
import { prepareMcpStdioLaunch } from "../src/mcp/launch.js"
import { nextConnectRetryMs } from "../src/mcp/retry.js"
import { StderrTail } from "../src/mcp/stderr-tail.js"
import { McpStdioTransport } from "../src/mcp/transport.js"
import { locateExecutable } from "../src/runtime/which.js"

const fixturePath = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url))

const folders: Array<string> = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

const tempFolder = async (): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), "arden-mcp-stdio-"))
  folders.push(folder)
  return folder
}

const writeProgram = async (path: string, body: string, mode = 0o755): Promise<string> => {
  await writeFile(path, body, "utf8")
  await chmod(path, mode)
  return path
}

const stdio = (command: string, args: ReadonlyArray<string> = [], cwd: string | null = null) =>
  ({ type: "stdio", command, args, environmentKeys: [], cwd }) as const

describe("a launched server's environment", () => {
  it("passes only the allowlist, puts the program's folder first, and lets saved values win", async () => {
    const bin = await tempFolder()
    const program = await writeProgram(join(bin, "npx"), "#!/bin/sh\n")
    const launch = await prepareMcpStdioLaunch({
      transport: stdio(program, [], bin),
      secrets: { GITHUB_TOKEN: "ghp_saved", LANG: "C" },
      loginPath: "/opt/homebrew/bin:/usr/bin:/bin",
      inherited: {
        HOME: "/Users/p",
        USER: "p",
        TMPDIR: "/var/folders/x/T/",
        LANG: "en_US.UTF-8",
        NODE_USE_SYSTEM_CA: "1",
        PATH: "/usr/bin:/bin",
        ARDEN_DIR: "/Users/p/.arden",
        OPENAI_API_KEY: "sk-live",
        NODE_OPTIONS: "--inspect"
      }
    })
    const { PATH, ...rest } = launch.environment
    expect(rest).toEqual({
      HOME: "/Users/p",
      USER: "p",
      TMPDIR: "/var/folders/x/T/",
      LANG: "C",
      NODE_USE_SYSTEM_CA: "1",
      NO_UPDATE_NOTIFIER: "1",
      npm_config_update_notifier: "false",
      GITHUB_TOKEN: "ghp_saved",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.bareRepository",
      GIT_CONFIG_VALUE_0: "explicit"
    })
    expect(PATH?.startsWith(`${bin}:`)).toBe(true)
    expect(PATH?.split(":")).toEqual(
      expect.arrayContaining(["/opt/homebrew/bin", "/usr/bin", "/bin"])
    )
  })
})

describe("classifyMcpStartFailure", () => {
  const base = { executable: "/opt/homebrew/bin/npx", exited: false, stderr: undefined }

  it("maps each known cause to its reason", () => {
    const cases = [
      classifyMcpStartFailure({ ...base, cause: new McpTimeoutError(60_000), exited: true }),
      classifyMcpStartFailure({
        ...base,
        cause: new Error("Connection closed"),
        exited: true,
        stderr: "npm warn\nError: GITHUB_TOKEN is not set"
      }),
      classifyMcpStartFailure({
        ...base,
        cause: Object.assign(new Error("x"), { code: "EACCES" })
      }),
      classifyMcpStartFailure({
        ...base,
        cause: new McpStartFailure({
          reason: "command_not_found",
          command: "npx",
          pathSource: "login_shell"
        })
      }),
      classifyMcpStartFailure({ ...base, cause: new Error("invalid JSON-RPC") })
    ]
    expect(cases).toEqual([
      { reason: "timeout", seconds: 60 },
      { reason: "exited_early", stderr: "npm warn\nError: GITHUB_TOKEN is not set" },
      { reason: "not_executable", path: "/opt/homebrew/bin/npx" },
      { reason: "command_not_found", command: "npx", pathSource: "login_shell" },
      undefined
    ])
  })
})

describe("McpStdioTransport", () => {
  it("keeps what a server wrote to stderr before it exited during start", async () => {
    const folder = await tempFolder()
    const program = await writeProgram(
      join(folder, "broken-mcp"),
      "#!/bin/sh\nprintf 'starting\\n' >&2\nprintf 'fatal: missing API_TOKEN=tok_12345678\\n' >&2\nexit 1\n"
    )
    const launch = await prepareMcpStdioLaunch({
      transport: stdio(program),
      secrets: {},
      loginPath: undefined,
      inherited: { PATH: "/usr/bin:/bin" }
    })
    const client = makeMcpClient()
    const transport = new McpStdioTransport(launch)
    const cause = await connectMcpClient(client, transport, 30_000).catch((error: unknown) => error)
    const detail = classifyMcpStartFailure({
      cause,
      executable: transport.executable,
      exited: transport.exited,
      stderr: transport.stderrTail()
    })
    await closeMcpClient({ client, transport })
    expect(detail).toEqual({
      reason: "exited_early",
      stderr: "starting\nfatal: missing API_TOKEN=[redacted]"
    })
  })

  it("fails a write to a server that is gone only once its exit and stderr are in", async () => {
    const folder = await tempFolder()
    const program = await writeProgram(
      join(folder, "gone-mcp"),
      "#!/bin/sh\nexec 0<&-\nprintf 'fatal: no config\\n' >&2\nsleep 0.1\nexit 1\n"
    )
    const transport = new McpStdioTransport(
      await prepareMcpStdioLaunch({
        transport: stdio(program),
        secrets: {},
        loginPath: undefined,
        inherited: { PATH: "/usr/bin:/bin" }
      })
    )
    await transport.start()
    while (transport.stderrTail() === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const failure = await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" }).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(Error)
    expect([transport.exited, transport.stderrTail()]).toEqual([true, "fatal: no config"])
    await transport.close()
  })
})

describe("connect budget and retries", () => {
  it("retries a first start once for a transient cause, and a crash up to three times", () => {
    const retry = (
      phase: "starting" | "reconnecting",
      attempt: number,
      reason: McpFailureReason | undefined,
      needsAuth = false
    ) => nextConnectRetryMs({ phase, attempt, reason, needsAuth })

    expect([
      retry("starting", 0, "exited_early"),
      retry("starting", 0, "timeout"),
      retry("starting", 1, "timeout"),
      retry("starting", 0, "command_not_found"),
      retry("starting", 0, "not_executable"),
      retry("starting", 0, undefined),
      retry("reconnecting", 0, "exited_early"),
      retry("reconnecting", 1, undefined),
      retry("reconnecting", 2, "timeout"),
      retry("reconnecting", 3, "timeout"),
      retry("reconnecting", 0, "command_not_found"),
      retry("reconnecting", 0, undefined, true)
    ]).toEqual([
      1_000,
      1_000,
      undefined,
      undefined,
      undefined,
      undefined,
      1_000,
      2_000,
      4_000,
      undefined,
      undefined,
      undefined
    ])
  })
})
