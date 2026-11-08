import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { SpaceStore } from "../src/persistence/spaces/store.js"
import type { SessionQueries } from "../src/persistence/sessions/queries.js"
import { offerFolderGrant } from "../src/tools/folder-grant.js"
import { partialService, serverRunContext } from "./kit.js"

let base = ""
const at = (...parts: ReadonlyArray<string>) => path.join(base, ...parts)
const headerSnapshot: unknown = { header: { spaceId: "space" } }
const spaceRow: unknown = { archived_at: null }
const offerTo = async (...files: ReadonlyArray<string>) =>
  (
    await offerFolderGrant(
      {
        dataDir: at("home", "arden"),
        sessions: partialService<SessionQueries["Service"]>("SessionQueries", {
          loadHeaderSnapshot: () => Effect.succeed(headerSnapshot as never)
        }),
        spaces: partialService<SpaceStore["Service"]>("SpaceStore", {
          get: () => Effect.succeed(spaceRow as never)
        })
      },
      { run: serverRunContext({ sessionId: "chat" }), signal: new AbortController().signal },
      files
    )
  )?.folder

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "arden-folder-grant-rule-")))
  vi.stubEnv("HOME", at("home"))
  for (const folder of [
    ["home", ".git"],
    ["home", "notes"],
    ["home", "arden", "skills"],
    ["home", "src", "margin", ".git"],
    ["home", "src", "margin", "app", "lib"],
    ["home", "src", "dots", ".git"],
    ["home", "Downloads"],
    ["home", ".ssh"],
    ["home", "Library", "LaunchAgents"],
    ["home", ".config", ".git"],
    ["home", ".config", "gh"],
    ["home", ".config", "nvim"]
  ]) {
    await mkdir(at(...folder), { recursive: true })
  }
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(base, { recursive: true, force: true })
})

describe("the folder an approval card offers to keep", () => {
  it("is the project a file sits in, however deep the file is", async () => {
    await expect(
      offerTo(
        at("home", "src", "margin", "app", "lib", "a.ts"),
        at("home", "src", "margin", "b.md")
      )
    ).resolves.toBe(at("home", "src", "margin"))
  })

  it("is the files' own folder when no project holds them, even under a dotfiles repo at home", async () => {
    await expect(
      offerTo(at("home", "Downloads", "a.mp4"), at("home", "Downloads", "b.mp4"))
    ).resolves.toBe(at("home", "Downloads"))
    await expect(offerTo(at("home", "notes", "todo.md"))).resolves.toBe(at("home", "notes"))
  })

  it("is none when the files sit in different projects or folders", async () => {
    await expect(
      offerTo(at("home", "src", "margin", "a.ts"), at("home", "src", "dots", "b.ts"))
    ).resolves.toBeUndefined()
    await expect(
      offerTo(at("home", "src", "margin", "a.ts"), at("home", "Downloads", "b.mp4"))
    ).resolves.toBeUndefined()
  })

  it("is never the home folder, a folder holding it, or Arden's own state", async () => {
    await expect(offerTo(at("home", "a.md"))).resolves.toBeUndefined()
    await expect(offerTo(at("a.md"))).resolves.toBeUndefined()
    await expect(offerTo(at("home", "arden", "skills", "SKILL.md"))).resolves.toBeUndefined()
  })

  it.each([
    [".ssh", "config"],
    ["Library", "LaunchAgents", "x.plist"],
    [".config", "gh", "hosts.yml"],
    ["Library", "notes.md"]
  ])("is never a secret or startup folder, or one holding one (~/%s/…)", async (...file) => {
    await expect(offerTo(at("home", ...file))).resolves.toBeUndefined()
  })

  it.each([
    [".config", "nvim", "init.lua"],
    [".local", "bin", "tool"],
    ["Library", "Preferences", "app.plist"]
  ])("is never inside home's hidden folders or Library (~/%s/…)", async (...file) => {
    await expect(offerTo(at("home", ...file))).resolves.toBeUndefined()
  })
})
