import { NO_PATH_RULES } from "./fixtures/local-policy.js"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { runCommandUntil } from "../src/tools/shell-run.js"
import { ardenStateRoot } from "../src/storage/local-paths.js"
import { exists } from "./agent-bash-sandbox-kit.js"

describe("Git outside the sandbox", () => {
  it("refuses a bare repository planted in the working tree under host access", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "arden-host-bare-"))
    const bare = path.join(directory, "bare")
    await Promise.all([
      mkdir(path.join(bare, "objects"), { recursive: true }),
      mkdir(path.join(bare, "refs"), { recursive: true })
    ])
    await Promise.all([
      writeFile(path.join(bare, "HEAD"), "ref: refs/heads/main\n", "utf8"),
      writeFile(
        path.join(bare, "config"),
        "[core]\n\tbare = true\n\tpager = touch ../pwned\n",
        "utf8"
      )
    ])
    const host = {
      cwd: directory,
      readRoots: null,
      writeRoot: null,
      stateRoot: "/nonexistent/arden-state",
      sandbox: "host_approved" as const,
      pathRules: NO_PATH_RULES
    }
    const run = (command: string) =>
      runCommandUntil(command, directory, AbortSignal.timeout(10_000), host, {
        yieldMs: 60_000,
        environment: { PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin" },
        loginPath: undefined,
        temporaryDirectory: directory
      })
    try {
      await expect(run("git --git-dir=bare config core.pager")).resolves.toMatchObject({
        state: "exited",
        exitCode: 0,
        output: "touch ../pwned\n"
      })
      await expect(run("cd bare && git rev-parse --git-dir")).rejects.toThrow(
        "cannot use bare repository"
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

it("does not run a code-agent command without a sandbox root", async () => {
  await expect(
    runCommandUntil(
      "/usr/bin/true",
      tmpdir(),
      AbortSignal.timeout(5_000),
      {
        cwd: tmpdir(),
        readRoots: null,
        writeRoot: null,
        stateRoot: "/nonexistent/arden-state",
        sandbox: "code_agent",
        pathRules: NO_PATH_RULES
      },
      { yieldMs: 60_000 }
    )
  ).rejects.toMatchObject({ preview: "Sandbox unavailable" })
})

it("does not start a command after cancellation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "arden-cancelled-bash-"))
  const target = path.join(directory, "must-not-exist")
  const controller = new AbortController()
  controller.abort()
  try {
    await expect(
      runCommandUntil(
        `/usr/bin/touch ${JSON.stringify(target)}`,
        directory,
        controller.signal,
        {
          cwd: directory,
          readRoots: null,
          writeRoot: null,
          stateRoot: "/nonexistent/arden-state",
          sandbox: null,
          pathRules: NO_PATH_RULES
        },
        { yieldMs: 60_000 }
      )
    ).rejects.toThrow()
    expect(await exists(target)).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("kills a running command when cancellation is requested", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "arden-running-bash-cancel-"))
  const started = path.join(directory, "started")
  const completed = path.join(directory, "completed")
  const controller = new AbortController()
  const command = runCommandUntil(
    `/usr/bin/touch ${JSON.stringify(started)}; /bin/sleep 1; /usr/bin/touch ${JSON.stringify(completed)}`,
    directory,
    controller.signal,
    {
      cwd: directory,
      readRoots: null,
      writeRoot: null,
      stateRoot: "/nonexistent/arden-state",
      sandbox: null,
      pathRules: NO_PATH_RULES
    },
    { yieldMs: 60_000 }
  )
  const settled = command.catch(() => undefined)
  try {
    const deadline = Date.now() + 2_000
    while (!(await exists(started)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(await exists(started)).toBe(true)

    controller.abort()

    await expect(command).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(await exists(completed)).toBe(false)
  } finally {
    controller.abort()
    await settled
    await rm(directory, { recursive: true, force: true })
  }
})

it("canonicalizes a symlinked Arden state root", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "arden-state-root-"))
  const target = path.join(directory, "state")
  const alias = path.join(directory, "state-link")
  try {
    await mkdir(target)
    await symlink(target, alias, "dir")
    expect(ardenStateRoot(alias)).toBe(await realpath(target))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform !== "darwin")("Bash sandbox process access", () => {
  it("lets host access inspect and signal the user's processes; the sandbox lists but cannot signal them", async () => {
    const directory = await realpath(await mkdtemp(path.join("/private/tmp", "arden-ps-")))
    const protectedRoot = path.join(directory, "arden-state")
    await mkdir(protectedRoot)
    const other = spawn("/bin/sleep", ["30"], { stdio: "ignore" })
    const pid = other.pid
    if (pid === undefined) throw new Error("sleep did not start")
    const host = {
      cwd: directory,
      readRoots: null,
      writeRoot: null,
      stateRoot: "/nonexistent/arden-state",
      sandbox: "host_approved" as const,
      pathRules: NO_PATH_RULES
    }
    const sandboxed = {
      cwd: directory,
      readRoots: [directory],
      writeRoot: directory,
      stateRoot: protectedRoot,
      sandbox: "code_agent" as const,
      pathRules: NO_PATH_RULES
    }
    const run = (command: string, policy: typeof host | typeof sandboxed) =>
      runCommandUntil(command, directory, AbortSignal.timeout(10_000), policy, { yieldMs: 60_000 })
    try {
      for (const policy of [host, sandboxed]) {
        await expect(run(`ps -p ${pid} -o pid=`, policy)).resolves.toMatchObject({
          state: "exited",
          exitCode: 0,
          output: expect.stringContaining(String(pid))
        })
        await expect(
          run("/bin/sleep 30 & kill $! && echo signalled", policy)
        ).resolves.toMatchObject({ state: "exited", output: "signalled\n" })
      }
      await expect(run(`kill -0 ${pid}`, host)).resolves.toMatchObject({
        state: "exited",
        exitCode: 0
      })
      await expect(run(`kill -0 ${pid}`, sandboxed)).rejects.toThrow(
        "comes from Arden's command sandbox"
      )
    } finally {
      other.kill()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
