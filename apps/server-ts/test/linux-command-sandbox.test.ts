import { NO_PATH_RULES } from "./fixtures/local-policy.js"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { bubblewrapFailure, type CommandSandbox } from "../src/runtime/command-sandbox.js"
import {
  sandboxUnavailableMessage,
  shellInvocation,
  shellRuntime
} from "../src/tools/shell-policy.js"
import { runCommandUntil } from "../src/tools/shell-run.js"
import type { LiveProcess } from "../src/terminals/live-process.js"
import type { LocalPathPolicy } from "../src/storage/local-paths.js"

const root = tmpdir()
const policies: Record<"host_approved" | "approved_local" | "code_agent", LocalPathPolicy> = {
  host_approved: {
    cwd: root,
    readRoots: null,
    writeRoot: null,
    stateRoot: "/nonexistent/arden-state",
    sandbox: "host_approved",
    pathRules: NO_PATH_RULES
  },
  approved_local: {
    cwd: root,
    readRoots: [root],
    writeRoot: root,
    stateRoot: "/home/me/.arden",
    sandbox: "approved_local",
    pathRules: NO_PATH_RULES
  },
  code_agent: {
    cwd: root,
    readRoots: [root],
    writeRoot: root,
    stateRoot: "/home/me/.arden",
    sandbox: "code_agent",
    pathRules: NO_PATH_RULES
  }
}

const linux = (commandSandbox: CommandSandbox) =>
  shellRuntime({
    environment: { PATH: "/usr/bin:/bin" },
    loginPath: undefined,
    homeDirectory: "/home/me",
    temporaryDirectory: root,
    platform: "linux",
    commandSandbox
  })

const backend = (kind: keyof typeof policies, status: CommandSandbox): string => {
  try {
    return shellInvocation("echo hi", root, policies[kind], linux(status)).executable
  } catch (cause) {
    return cause instanceof Error ? `refused: ${cause.message}` : "refused"
  }
}

describe("Linux command backend", () => {
  it("runs host access with no sandbox, and a sandboxed kind under bubblewrap or not at all", () => {
    const statuses = ["ready", "missing", "no_namespaces", "failed"] as const
    const table = Object.fromEntries(
      (["host_approved", "approved_local", "code_agent"] as const).map((kind) => [
        kind,
        Object.fromEntries(statuses.map((status) => [status, backend(kind, status)]))
      ])
    )
    expect(table).toEqual({
      host_approved: {
        ready: "/bin/bash",
        missing: "/bin/bash",
        no_namespaces: "/bin/bash",
        failed: "/bin/bash"
      },
      approved_local: {
        ready: "/usr/bin/bwrap",
        missing: `refused: ${sandboxUnavailableMessage("missing")}`,
        no_namespaces: `refused: ${sandboxUnavailableMessage("no_namespaces")}`,
        failed: `refused: ${sandboxUnavailableMessage("failed")}`
      },
      code_agent: {
        ready: "/usr/bin/bwrap",
        missing: `refused: ${sandboxUnavailableMessage("missing")}`,
        no_namespaces: `refused: ${sandboxUnavailableMessage("no_namespaces")}`,
        failed: `refused: ${sandboxUnavailableMessage("failed")}`
      }
    })
  })

  it("runs a host command as plain bash with the host environment, on Linux and macOS", () => {
    const invocation = shellInvocation("echo hi", root, policies.host_approved, linux("ready"))
    expect([invocation.executable, ...invocation.args]).toEqual(["/bin/bash", "-c", "echo hi"])
    expect(invocation.env["HOME"]).toBe("/home/me")
    const mac = shellRuntime({
      platform: "darwin",
      commandSandbox: "not_linux",
      temporaryDirectory: root
    })
    expect(shellInvocation("echo hi", root, policies.host_approved, mac).executable).toBe(
      "/bin/bash"
    )
    for (const kind of ["approved_local", "code_agent"] as const)
      expect(shellInvocation("echo hi", root, policies[kind], mac).executable).toBe(
        "/usr/bin/sandbox-exec"
      )
  })
})

describe("Linux sandbox rule", () => {
  it("reads the disk, hides secret folders, writes the root and temp, and opens the network only when approved", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "arden-bwrap-home-")))
    const workspace = path.join(home, "project")
    const tools = path.join(home, ".local", "bin")
    await Promise.all([
      mkdir(path.join(home, ".ssh"), { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(tools, { recursive: true })
    ])
    const policy: LocalPathPolicy = {
      ...policies.code_agent,
      cwd: workspace,
      readRoots: [workspace],
      writeRoot: workspace
    }
    const runtime = shellRuntime({
      environment: { PATH: "/usr/bin:/bin" },
      loginPath: undefined,
      homeDirectory: home,
      temporaryDirectory: root,
      platform: "linux",
      commandSandbox: "ready"
    })
    const args = (network: boolean) =>
      shellInvocation("lab run", workspace, { ...policy, network }, runtime).args.join(" ")
    try {
      const sandboxed = args(false)
      expect(sandboxed).toContain("--ro-bind / /")
      expect(sandboxed).toContain(`--tmpfs ${path.join(home, ".ssh")}`)
      expect(sandboxed).toContain(`--bind-try ${workspace} ${workspace}`)
      expect(sandboxed).not.toContain(tools)
      expect(sandboxed).toContain("--unshare-net")
      expect(args(true)).not.toContain("--unshare-net")
      expect(shellInvocation("lab run", workspace, policy, runtime).env["HOME"]).toBe(home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("Linux sandbox with HOME as its root", () => {
  it("masks secrets after binding the root, so the root cannot reopen them", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "arden-bwrap-root-")))
    await mkdir(path.join(home, ".ssh"))
    await writeFile(path.join(home, ".zshrc"), "", "utf8")
    const policy: LocalPathPolicy = {
      ...policies.approved_local,
      cwd: home,
      readRoots: [home],
      writeRoot: home
    }
    const runtime = shellRuntime({
      environment: { PATH: "/usr/bin:/bin" },
      loginPath: undefined,
      homeDirectory: home,
      temporaryDirectory: root,
      platform: "linux",
      commandSandbox: "ready"
    })
    try {
      const args = shellInvocation("true", home, policy, runtime).args
      const position = (flag: string, target: string) =>
        args.findIndex((arg, index) => arg === flag && args[index + 1] === target)
      expect(position("--tmpfs", path.join(home, ".ssh"))).toBeGreaterThan(
        position("--bind-try", home)
      )
      expect(position("--ro-bind-try", home)).toBe(-1)
      expect(position("--ro-bind", path.join(home, ".zshrc"))).toBeGreaterThan(
        position("--bind-try", home)
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("bubblewrap failure", () => {
  it("never mistakes a command's own stderr for bubblewrap's", () => {
    expect(bubblewrapFailure("mkdir: cannot create directory: Operation not permitted")).toBe(
      undefined
    )
    expect(bubblewrapFailure("bwrap: Creating new namespace failed: Operation not permitted")).toBe(
      "no_namespaces"
    )
  })
})

const exitingProcess = (stderr: string, code: number): LiveProcess => ({
  pid: 1,
  input: "closed",
  onData: (listener) => {
    queueMicrotask(() => listener("stderr", Buffer.from(stderr)))
    return () => {}
  },
  onExit: (listener) => {
    setTimeout(() => listener({ kind: "code", code }), 0)
    return () => {}
  },
  onSpawnError: () => () => {},
  exit: () => undefined,
  write: () => false,
  interrupt: () => {},
  kill: () => {}
})

describe("bubblewrap failure at run time", () => {
  it("names the cause instead of reporting bubblewrap's exit code", async () => {
    await expect(
      runCommandUntil("echo hi", root, new AbortController().signal, policies.approved_local, {
        yieldMs: 60_000,
        ...linux("ready"),
        spawn: () => exitingProcess("bwrap: setting up uid map: Permission denied\n", 1)
      })
    ).rejects.toMatchObject({
      message: sandboxUnavailableMessage("no_namespaces"),
      preview: "Sandbox unavailable"
    })
  })

  it("leaves a sandboxed command's own failure as it is", async () => {
    await expect(
      runCommandUntil("false", root, new AbortController().signal, policies.approved_local, {
        yieldMs: 60_000,
        ...linux("ready"),
        spawn: () => exitingProcess("touch: Operation not permitted\n", 1)
      })
    ).rejects.toMatchObject({ preview: "Exit 1" })
  })
})
