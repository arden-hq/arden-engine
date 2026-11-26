import { NO_PATH_RULES } from "./fixtures/local-policy.js"
import { createServer } from "node:net"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { runCommandUntil } from "../src/tools/shell-run.js"

import { exists } from "./agent-bash-sandbox-kit.js"

describe.skipIf(process.platform !== "darwin")("Bash sandbox", () => {
  it("lets a code agent run a tool from HOME but not read a secret folder or reach local sockets", async () => {
    const directory = await realpath(await mkdtemp(path.join("/private/tmp", "arden-agent-home-")))
    const workspace = path.join(directory, "workspace")
    const home = path.join(directory, "home")
    const bin = path.join(home, ".local", "bin")
    await Promise.all([
      mkdir(workspace),
      mkdir(bin, { recursive: true }),
      mkdir(path.join(home, ".ssh"), { recursive: true })
    ])
    await writeFile(path.join(home, ".ssh", "id_ed25519"), "private key\n", "utf8")
    await writeFile(path.join(bin, "lab"), '#!/bin/bash\necho "lab ran in $HOME"\n', "utf8")
    await chmod(path.join(bin, "lab"), 0o755)
    const agentSocket = path.join(directory, "agent.sock")
    const agent = createServer((socket) => socket.end("agent\n"))
    await new Promise<void>((resolve) => agent.listen(agentSocket, resolve))
    const server = createServer((socket) => socket.end("hello\n"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("no port")
    const policy = {
      cwd: workspace,
      readRoots: [workspace],
      writeRoot: workspace,
      stateRoot: path.join(directory, "arden-state"),
      sandbox: "code_agent" as const,
      pathRules: NO_PATH_RULES
    }
    const run = (command: string, network = false) =>
      runCommandUntil(
        command,
        workspace,
        AbortSignal.timeout(10_000),
        { ...policy, network },
        {
          yieldMs: 60_000,
          environment: { PATH: `${bin}:/usr/bin:/bin` },
          loginPath: undefined,
          homeDirectory: home
        }
      )
    const connect = `/usr/bin/nc -w 2 127.0.0.1 ${address.port} </dev/null`
    try {
      await expect(run("lab")).resolves.toMatchObject({
        state: "exited",
        output: `lab ran in ${home}\n`
      })
      await expect(
        run(`/bin/cat ${JSON.stringify(path.join(home, ".ssh", "id_ed25519"))}`)
      ).rejects.toThrow("comes from Arden's command sandbox")
      await expect(run(connect)).rejects.toThrow()
      await expect(run(connect, true)).rejects.toThrow()
      await expect(run(`/usr/bin/nc -U ${agentSocket} </dev/null`, true)).rejects.toThrow()
    } finally {
      agent.close()
      server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("runs ordinary Git in the sandbox while hooks, config and pointers stay closed", async () => {
    const workspace = await realpath(await mkdtemp(path.join("/private/tmp", "arden-agent-git-")))
    const dotGit = path.join(workspace, ".git")
    const sandboxAt = (root: string) => ({
      cwd: root,
      readRoots: null,
      writeRoot: root,
      stateRoot: path.join(workspace, "arden-state"),
      sandbox: "code_agent" as const,
      pathRules: NO_PATH_RULES
    })
    const host = {
      cwd: workspace,
      readRoots: null,
      writeRoot: null,
      stateRoot: "/nonexistent/arden-state",
      sandbox: "host_approved" as const,
      pathRules: NO_PATH_RULES
    }
    const git = "git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false"
    const run = (command: string, root = workspace) =>
      runCommandUntil(command, root, AbortSignal.timeout(15_000), sandboxAt(root), {
        yieldMs: 60_000
      })
    const onHost = (command: string) =>
      runCommandUntil(command, workspace, AbortSignal.timeout(15_000), host, { yieldMs: 60_000 })
    try {
      await expect(run("git init -q")).rejects.toThrow()
      await expect(run("/bin/mkdir .git")).rejects.toThrow()
      await onHost(
        `git init -q && /bin/mkdir nested && cd nested && git init -q && cd .. && ${git} commit -q --allow-empty -m root && ${git} worktree add -q linked`
      )
      for (const command of [
        "/usr/bin/touch a.txt",
        `${git} add a.txt && ${git} commit -q -m first`,
        `${git} branch feature && ${git} checkout -q feature`,
        `/bin/echo b > a.txt && ${git} stash -q && ${git} stash list`,
        `cd nested && ${git} commit -q --allow-empty -m nested`,
        `${git} branch team/x && ${git} branch -D -q team/x`,
        `${git} pack-refs --all && ${git} gc -q`
      ])
        await expect(run(command)).resolves.toMatchObject({ state: "exited", exitCode: 0 })
      const allowed: string[] = []
      for (const command of [
        "/usr/bin/touch .git/hooks/pre-commit",
        "git config core.hooksPath /tmp/h",
        "git config core.fsmonitor /tmp/x",
        "git config core.sshCommand /tmp/x",
        "git remote add origin https://example.com/a.git",
        "/bin/echo '[core] fsmonitor = /tmp/x' >> .git/config",
        "/bin/echo /tmp/evil > .git/commondir",
        "/bin/mv .git/config c",
        "/bin/mv .git g2",
        "/bin/mkdir -p h/hooks && /usr/bin/touch h/hooks/pre-commit && /bin/mv h .agents",
        `${git} worktree add -q wt1 -b b1 && /bin/echo $PWD/nested/.git > .git/worktrees/wt1/commondir`,
        "/bin/mkdir -p .git/worktrees/x && /bin/echo /tmp/evil > .git/worktrees/x/commondir",
        "/bin/echo /tmp/evil > .git/worktrees/linked/commondir",
        "/bin/mv .git/worktrees .git/w.old",
        "/bin/mv .git/worktrees/linked .git/l.old",
        "/bin/mkdir -p fake && /bin/echo /tmp/evil > fake/commondir && /bin/mv fake .git/worktrees/wt9",
        "git init -q sub",
        "/bin/mkdir -p sub/.git",
        "/bin/echo 'gitdir: ../nested/.git' > sub.gitfile && /bin/mkdir -p sub && /bin/mv sub.gitfile sub/.git",
        "/bin/echo '[core] fsmonitor = /tmp/x' >> nested/.git/config",
        "/bin/mv nested/.git nested/g2"
      ])
        if (
          await run(command).then(
            () => true,
            () => false
          )
        )
          allowed.push(command)
      expect(allowed).toEqual([])
      expect(await exists(path.join(workspace, ".agents"))).toBe(false)
      expect(await exists(path.join(workspace, "sub", ".git"))).toBe(false)
      expect(await exists(path.join(dotGit, "worktrees", "wt1", "commondir"))).toBe(false)
      await expect(onHost("git config --get core.fsmonitor")).rejects.toThrow()
      await expect(onHost("cd nested && git config --get core.fsmonitor")).rejects.toThrow()
      await onHost(
        `/bin/mkdir -p .git/hooks && printf '#!/bin/sh\\ntouch ${workspace}/ran\\n' > .git/hooks/post-commit && chmod +x .git/hooks/post-commit`
      )
      await expect(run(`${git} commit -q --allow-empty -m second`)).resolves.toMatchObject({
        state: "exited",
        exitCode: 0
      })
      expect(await exists(path.join(workspace, "ran"))).toBe(false)
      const linked = path.join(workspace, "linked")
      await expect(
        run(`/bin/echo c > c.txt && ${git} add c.txt && ${git} commit -q -m linked`, linked)
      ).resolves.toMatchObject({ state: "exited", exitCode: 0 })
      for (const command of [
        `/usr/bin/touch ${dotGit}/hooks/pre-commit`,
        `/bin/echo /tmp/evil > ${dotGit}/worktrees/linked/commondir`,
        `/bin/echo x >> ${dotGit}/config`,
        `/bin/mv ${dotGit} ${workspace}/g3`,
        `/bin/mv ${dotGit}/worktrees ${dotGit}/worktrees.old`,
        `/bin/mkdir -p /tmp/arden-fake-wt && /bin/echo /tmp/evil > /tmp/arden-fake-wt/commondir && /bin/mv /tmp/arden-fake-wt ${dotGit}/worktrees/wt`
      ])
        await expect(run(command, linked)).rejects.toThrow()
      await expect(onHost("cd linked && git rev-parse --git-common-dir")).resolves.toMatchObject({
        state: "exited",
        output: `${dotGit}\n`
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm("/tmp/arden-fake-wt", { recursive: true, force: true })
    }
  })

  it("keeps secrets hidden when the Local folder is HOME itself", async () => {
    const home = await realpath(await mkdtemp(path.join("/private/tmp", "arden-home-root-")))
    await mkdir(path.join(home, ".ssh"))
    await mkdir(path.join(home, ".aws"))
    await mkdir(path.join(home, "Library", "LaunchAgents"), { recursive: true })
    await mkdir(path.join(home, ".config", "gcloud"), { recursive: true })
    await writeFile(path.join(home, ".config", "gcloud", "token"), "token\n", "utf8")
    await writeFile(path.join(home, ".ssh", "id"), "key\n", "utf8")
    await writeFile(path.join(home, ".aws", "credentials"), "aws\n", "utf8")
    await writeFile(path.join(home, ".npmrc"), "//registry/:_authToken=x\n", "utf8")
    await writeFile(path.join(home, "notes.txt"), "notes\n", "utf8")
    await symlink(path.join(home, ".ssh", "id"), path.join(home, "link"))
    const policy = {
      cwd: home,
      readRoots: [home],
      writeRoot: home,
      stateRoot: path.join(home, "arden-state"),
      sandbox: "approved_local" as const,
      pathRules: NO_PATH_RULES
    }
    const run = (command: string) =>
      runCommandUntil(command, home, AbortSignal.timeout(10_000), policy, {
        yieldMs: 60_000,
        environment: { PATH: "/usr/bin:/bin" },
        loginPath: undefined,
        homeDirectory: home
      })
    try {
      await expect(run("/bin/cat notes.txt")).resolves.toMatchObject({
        state: "exited",
        output: "notes\n"
      })
      for (const command of [
        "/bin/cat .ssh/id",
        "/bin/cat .aws/credentials",
        "/bin/cat .npmrc",
        "/bin/cat link",
        "/usr/bin/touch .ssh/planted",
        "/usr/bin/touch .zshrc",
        "/bin/mkdir -p Library/LaunchAgents && /usr/bin/touch Library/LaunchAgents/x.plist",
        "/bin/mkdir -p .git/hooks && /usr/bin/touch .git/hooks/pre-commit",
        "/bin/mv Library L2",
        "/bin/mv .config c2 && /bin/cat c2/gcloud/token"
      ])
        await expect(run(command), command).rejects.toThrow()
      expect(await exists(path.join(home, ".ssh", "planted"))).toBe(false)
      expect(await exists(path.join(home, ".zshrc"))).toBe(false)
      await expect(run("/usr/bin/touch made.txt")).resolves.toMatchObject({
        state: "exited",
        exitCode: 0
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("contains ordinary Bash to its Local root and reads only skill resources from Arden state", async () => {
    const directory = await mkdtemp(path.join("/private/tmp", "arden-local-bash-"))
    const localRootInput = path.join(directory, "local")
    const ardenRootInput = path.join(directory, "arden-state")
    const skillsRootInput = path.join(ardenRootInput, "skills")
    await Promise.all([mkdir(localRootInput), mkdir(skillsRootInput, { recursive: true })])
    await writeFile(path.join(ardenRootInput, "secret"), "secret\n", "utf8")
    await writeFile(path.join(skillsRootInput, "helper.py"), "print('ready')\n", "utf8")
    const localRoot = await realpath(localRootInput)
    const ardenRoot = await realpath(ardenRootInput)
    const skillsRoot = await realpath(skillsRootInput)
    const inside = path.join(localRoot, "inside.txt")
    const elsewhere = await mkdtemp(path.join("/private/var/tmp", "arden-local-outside-"))
    const sibling = path.join(elsewhere, "sibling.txt")
    const protectedFile = path.join(ardenRoot, "secret")
    const policy = {
      cwd: localRoot,
      readRoots: [localRoot],
      readOnlyRoots: [skillsRoot],
      writeRoot: localRoot,
      stateRoot: ardenRoot,
      sandbox: "approved_local" as const,
      pathRules: NO_PATH_RULES
    }
    try {
      await expect(
        runCommandUntil(
          `/usr/bin/touch ${JSON.stringify(inside)}`,
          localRoot,
          AbortSignal.timeout(5_000),
          policy,
          { yieldMs: 60_000 }
        )
      ).resolves.toMatchObject({ state: "exited", exitCode: 0 })
      expect(await exists(inside)).toBe(true)

      await expect(
        runCommandUntil(
          `/usr/bin/touch ${JSON.stringify(sibling)}`,
          localRoot,
          AbortSignal.timeout(5_000),
          policy,
          { yieldMs: 60_000 }
        )
      ).rejects.toThrow()
      expect(await exists(sibling)).toBe(false)

      await expect(
        runCommandUntil(
          `/bin/cat ${JSON.stringify(protectedFile)}`,
          localRoot,
          AbortSignal.timeout(5_000),
          policy,
          { yieldMs: 60_000 }
        )
      ).rejects.toThrow()
      await expect(
        runCommandUntil(
          `/bin/cat ${JSON.stringify(path.join(skillsRoot, "helper.py"))}`,
          localRoot,
          AbortSignal.timeout(5_000),
          policy,
          { yieldMs: 60_000 }
        )
      ).resolves.toMatchObject({ state: "exited", output: "print('ready')\n", exitCode: 0 })
      await expect(
        runCommandUntil(
          `/usr/bin/touch ${JSON.stringify(path.join(ardenRoot, "blocked"))}`,
          localRoot,
          AbortSignal.timeout(5_000),
          policy,
          { yieldMs: 60_000 }
        )
      ).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it("runs a host CLI with user HOME and PATH and no credential variables", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "arden-host-bash-"))
    const workspace = path.join(directory, "workspace")
    const userHome = path.join(directory, "home")
    const bin = path.join(directory, "bin")
    const executable = path.join(bin, "prime")
    const cache = path.join(userHome, ".prime-cache")
    await Promise.all([mkdir(workspace), mkdir(userHome), mkdir(bin)])
    await Promise.all([
      writeFile(path.join(userHome, ".prime-auth"), "ready", "utf8"),
      writeFile(
        executable,
        [
          "#!/bin/bash",
          "set -eu",
          'test -z "${ARDEN_INTERNAL_TOKEN:-}"',
          'printf \'authenticated:%s\' "$(cat "$HOME/.prime-auth")"',
          'touch "$HOME/.prime-cache"'
        ].join("\n"),
        "utf8"
      )
    ])
    await chmod(executable, 0o755)
    const policy = {
      cwd: workspace,
      readRoots: null,
      writeRoot: null,
      stateRoot: "/nonexistent/arden-state",
      sandbox: "host_approved" as const,
      pathRules: NO_PATH_RULES
    }
    try {
      await expect(
        runCommandUntil("prime", workspace, AbortSignal.timeout(5_000), policy, {
          yieldMs: 60_000,
          environment: {
            PATH: `${bin}:/usr/bin:/bin`,
            ARDEN_INTERNAL_TOKEN: "must-not-leak"
          },
          homeDirectory: userHome,
          temporaryDirectory: directory
        })
      ).resolves.toMatchObject({ state: "exited", output: "authenticated:ready", exitCode: 0 })
      expect(await exists(cache)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
