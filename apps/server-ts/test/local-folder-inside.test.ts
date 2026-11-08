import { NO_PATH_RULES } from "./fixtures/local-policy.js"
import { describe, expect, it } from "vitest"
import { insideLocalFolder } from "../src/storage/local-paths.js"

const policy = {
  cwd: "/Users/me/src/ntrp",
  localRoots: ["/Users/me/src/ntrp", "/Users/me/docs"],
  readRoots: null,
  writeRoot: null,
  stateRoot: "/nonexistent/arden-state",
  sandbox: null,
  pathRules: NO_PATH_RULES,
  usableRoots: []
} as const

describe("insideLocalFolder", () => {
  it("accepts the folder itself and paths under any Local folder", () => {
    expect(insideLocalFolder(policy, "/Users/me/src/ntrp")).toBe(true)
    expect(insideLocalFolder(policy, "/Users/me/src/ntrp/apps/a.ts")).toBe(true)
    expect(insideLocalFolder(policy, "/Users/me/docs/notes.md")).toBe(true)
  })
  it("rejects siblings, parents, and prefix look-alikes", () => {
    expect(insideLocalFolder(policy, "/Users/me/src/ntrp-old/a.ts")).toBe(false)
    expect(insideLocalFolder(policy, "/Users/me/src")).toBe(false)
    expect(insideLocalFolder(policy, "/etc/hosts")).toBe(false)
  })
  it("counts a sandbox write root as inside", () => {
    expect(
      insideLocalFolder({ ...policy, localRoots: [], writeRoot: "/tmp/agent" }, "/tmp/agent/x")
    ).toBe(true)
  })
})
