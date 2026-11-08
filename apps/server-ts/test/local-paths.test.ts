import { NO_RULES } from "./fixtures/local-policy.js"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { SpaceStore } from "../src/persistence/spaces/store.js"
import type { SessionQueries } from "../src/persistence/sessions/queries.js"
import {
  displayLocalPath,
  policyPathOptions,
  resolveLocalPath,
  sandboxRule,
  sessionPathPolicy
} from "../src/storage/local-paths.js"
import { NO_PATH_RULES, localRunAuthority } from "./fixtures/local-policy.js"
import { partialService } from "./kit.js"

describe("Sandboxed file reads", () => {
  it("read the whole disk except secrets and Arden's state, and reopen only Skills inside it", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "arden-read-rule-")))
    const state = path.join(home, ".arden")
    const skills = path.join(state, "skills")
    await mkdir(path.join(home, ".ssh"))
    await mkdir(path.join(home, ".local", "bin"), { recursive: true })
    await mkdir(skills, { recursive: true })
    await mkdir(path.join(home, "project", ".git", "hooks"), { recursive: true })
    await Promise.all([
      writeFile(path.join(home, ".ssh", "id"), "key", "utf8"),
      writeFile(path.join(home, ".local", "bin", "lab"), "tool", "utf8"),
      writeFile(path.join(state, "arden.db"), "db", "utf8"),
      writeFile(path.join(skills, "SKILL.md"), "skill", "utf8")
    ])
    const rule = sandboxRule(
      {
        cwd: home,
        readRoots: null,
        readOnlyRoots: [skills, home],
        writeRoot: path.join(home, "project"),
        stateRoot: state,
        sandbox: "code_agent",
        pathRules: NO_PATH_RULES
      },
      home
    )
    const read = (target: string) =>
      resolveLocalPath(target, home, { readRoots: null, stateRoot: state, sandboxRule: rule }).then(
        () => "read",
        () => "refused"
      )
    try {
      expect({
        tool: await read(".local/bin/lab"),
        key: await read(".ssh/id"),
        db: await read(".arden/arden.db"),
        skill: await read(".arden/skills/SKILL.md")
      }).toEqual({ tool: "read", key: "refused", db: "refused", skill: "read" })
      const write = (target: string) =>
        resolveLocalPath(target, home, {
          allowMissing: true,
          mutation: true,
          readRoots: null,
          writeRoot: home,
          stateRoot: state,
          sandboxRule: rule
        }).then(
          () => "write",
          () => "refused"
        )
      expect({
        file: await write("notes.txt"),
        zshrc: await write(".zshrc"),
        hooks: await write("project/.git/hooks/pre-commit"),
        code: await write("project/main.ts")
      }).toEqual({ file: "write", zshrc: "refused", hooks: "refused", code: "write" })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("Local path containment", () => {
  it("distinguishes parent components from names beginning with two dots", () => {
    const root = path.join(tmpdir(), "local-root")
    expect(displayLocalPath(path.join(root, "..notes", "file"), root)).toBe("..notes/file")
    expect(displayLocalPath(root, root)).toBe(root)
    expect(displayLocalPath(`${root}-sibling`, root)).toBe(`${root}-sibling`)
  })

  it("writes an absolute path home-relative, the way a person writes it", () => {
    const home = homedir()
    expect(displayLocalPath(home, null)).toBe("~")
    expect(displayLocalPath(path.join(home, "src", "resume"), null)).toBe("~/src/resume")
    expect(displayLocalPath(`${home}-other`, null)).toBe(`${home}-other`)
    expect(displayLocalPath(path.join(home, "src", "resume"), path.join(home, "src"))).toBe(
      "resume"
    )
    expect(displayLocalPath(path.join(home, "src"), path.join(home, "other"))).toBe("~/src")
  })

  it("checks real targets and missing-file parents against the same root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "arden-local-paths-"))
    try {
      const root = path.join(await realpath(directory), "root")
      const notes = path.join(root, "..notes")
      const outside = path.join(await realpath(directory), "outside")
      await mkdir(notes, { recursive: true })
      await mkdir(outside)
      await writeFile(path.join(notes, "existing"), "inside")
      await writeFile(path.join(outside, "existing"), "outside")
      await symlink(notes, path.join(root, "inside-link"))
      await symlink(outside, path.join(root, "outside-link"))
      for (const mutation of [false, true]) {
        const options = {
          mutation,
          readRoots: [root],
          writeRoot: root,
          stateRoot: null,
          allowMissing: true
        }
        for (const name of ["existing", "missing"]) {
          await expect(resolveLocalPath(`..notes/${name}`, root, options)).resolves.toBe(
            path.join(notes, name)
          )
          await expect(resolveLocalPath(`inside-link/${name}`, root, options)).resolves.toBe(
            path.join(notes, name)
          )
          await expect(resolveLocalPath(`outside-link/${name}`, root, options)).rejects.toThrow(
            "outside this code agent's sandbox root"
          )
          await expect(resolveLocalPath(`../outside/${name}`, root, options)).rejects.toThrow(
            "outside this code agent's sandbox root"
          )
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

it("guards the server's data folder, not the folder ARDEN_DIR names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "arden-state-source-"))
  const dataDir = path.join(directory, "data")
  const elsewhere = path.join(directory, "elsewhere")
  const previous = process.env["ARDEN_DIR"]
  try {
    await mkdir(dataDir)
    await mkdir(elsewhere)
    process.env["ARDEN_DIR"] = elsewhere
    const policy = await sessionPathPolicy(
      {
        spaces: partialService<SpaceStore["Service"]>("Space", {}),
        rules: NO_RULES,
        sessions: partialService<SessionQueries["Service"]>("Session", {
          loadHeaderSnapshot: () => Effect.succeed(null)
        }),
        runs: localRunAuthority([{ sessionId: "chat", runId: "run", spaceId: null }]),
        dataDir
      },
      { sessionId: "chat", runId: "run", signal: new AbortController().signal }
    )
    expect(policy.stateRoot).toBe(await realpath(dataDir))
    await expect(
      resolveLocalPath(path.join(dataDir, "AGENTS.md"), null, {
        allowMissing: true,
        mutation: true,
        ...policyPathOptions(policy)
      })
    ).rejects.toThrow("inside Arden's own state directory")
  } finally {
    if (previous === undefined) delete process.env["ARDEN_DIR"]
    else process.env["ARDEN_DIR"] = previous
    await rm(directory, { recursive: true, force: true })
  }
})

describe("a never path rule", () => {
  const never = (folder: string, access: "read" | "change") => ({
    own: undefined,
    rules: [
      {
        id: `never-${access}`,
        subject: { kind: "path" as const, path: folder, access },
        list: { kind: "global" as const },
        decision: "never" as const,
        source: { kind: "settings" as const, runId: null },
        createdAt: null,
        fromRuleId: null
      }
    ]
  })

  it("refuses reading a file there, through a link too, and changing it", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "arden-never-")))
    const secret = path.join(base, "Private")
    await mkdir(secret)
    await writeFile(path.join(secret, "a.txt"), "x")
    await symlink(secret, path.join(base, "link"))
    const options = { stateRoot: null, pathRules: never(secret, "read") }
    await expect(resolveLocalPath(path.join(secret, "a.txt"), null, options)).rejects.toThrow(
      /never touches/
    )
    await expect(resolveLocalPath(path.join(base, "link", "a.txt"), null, options)).rejects.toThrow(
      /never touches/
    )
    await expect(
      resolveLocalPath(path.join(secret, "b.txt"), null, {
        ...options,
        mutation: true,
        allowMissing: true
      })
    ).rejects.toThrow(/never/)
    const readOnly = { stateRoot: null, pathRules: never(secret, "change") }
    await expect(resolveLocalPath(path.join(secret, "a.txt"), null, readOnly)).resolves.toBe(
      path.join(secret, "a.txt")
    )
    await expect(
      resolveLocalPath(path.join(secret, "a.txt"), null, { ...readOnly, mutation: true })
    ).rejects.toThrow(/never changes/)
    await rm(base, { recursive: true, force: true })
  })

  it("hides a never-read folder from a sandboxed command and write-protects a never-change one", () => {
    const policy = {
      cwd: "/Users/me/src/demo",
      readRoots: ["/Users/me/src/demo"],
      writeRoot: "/Users/me/src/demo",
      stateRoot: "/nonexistent/arden-state",
      sandbox: "approved_local" as const,
      pathRules: {
        own: undefined,
        rules: [
          ...never("/Users/me/Documents", "read").rules,
          ...never("/Users/me/taxes", "change").rules
        ]
      }
    }
    const rule = sandboxRule(policy, "/Users/me", "darwin")
    expect(rule?.hidden).toContain("/Users/me/Documents")
    expect(rule?.hidden).not.toContain("/Users/me/taxes")
    expect(rule?.writeProtected).toEqual(
      expect.arrayContaining(["/Users/me/Documents", "/Users/me/taxes"])
    )
  })
})
