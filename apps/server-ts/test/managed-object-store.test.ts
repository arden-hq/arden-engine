import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { makeManagedObjectStore } from "../src/artifacts/managed-output/object-store.js"

const hash = (value: string): string => createHash("sha256").update(value).digest("hex")

describe("managed object store", () => {
  it("publishes owner refs before returning and restores at a new root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arden-managed-object-"))
    const store = makeManagedObjectStore(path.join(root, "managed-outputs"))
    const text = `head🙂\n${"content\n".repeat(9000)}`
    try {
      const first = await store.publish({
        sessionId: "first",
        text,
        format: "text",
        source: { kind: "tool", name: "web_fetch", call_id: "call-1" }
      })
      expect(first.ref).toBe(`arden:managed-output/${hash("first")}/${hash(text)}/text`)
      expect(await store.read({ sessionId: "first", ref: first.ref })).toBe(text)
      await expect(store.read({ sessionId: "second", ref: first.ref })).rejects.toThrow("not owned")
      const second = await store.attach({ descriptor: first, sessionId: "second" })
      expect(second.ref).not.toBe(first.ref)
      expect(second.sha256).toBe(first.sha256)
      expect(await store.read({ sessionId: "second", ref: second.ref })).toBe(text)

      const moved = path.join(root, "relocated")
      const { cp } = await import("node:fs/promises")
      await cp(path.join(root, "managed-outputs"), moved, { recursive: true })
      expect(await makeManagedObjectStore(moved).read({ sessionId: "first", ref: first.ref })).toBe(
        text
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects guessed owner hash without a ref and corrupt object bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arden-managed-object-"))
    const store = makeManagedObjectStore(path.join(root, "managed-outputs"))
    try {
      const descriptor = await store.publish({
        sessionId: "first",
        text: "same bytes",
        format: "text",
        source: { kind: "tool", name: "x", call_id: "y" }
      })
      const guessed = `arden:managed-output/${hash("second")}/${descriptor.sha256}/text`
      await expect(store.read({ sessionId: "second", ref: guessed })).rejects.toThrow()
      const object = path.join(
        root,
        "managed-outputs",
        "objects",
        descriptor.sha256.slice(0, 2),
        descriptor.sha256
      )
      expect(await readFile(object, "utf8")).toBe("same bytes")
      await writeFile(object, "bad bytes")
      await expect(store.read({ sessionId: "first", ref: descriptor.ref })).rejects.toThrow(
        "corrupt"
      )
      await expect(store.attach({ descriptor, sessionId: "second" })).rejects.toThrow("corrupt")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects a symlinked owner ref before reading it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arden-managed-object-"))
    const store = makeManagedObjectStore(path.join(root, "managed-outputs"))
    try {
      const descriptor = await store.publish({
        sessionId: "first",
        text: "private text",
        format: "text",
        source: { kind: "tool", name: "x", call_id: "y" }
      })
      const refFile = path.join(
        root,
        "managed-outputs",
        "refs",
        descriptor.owner_session_hash,
        `${descriptor.sha256}.text.json`
      )
      await rm(refFile)
      await symlink(path.join(root, "other.json"), refFile)
      await expect(store.read({ sessionId: "first", ref: descriptor.ref })).rejects.toThrow(
        "Unsafe"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("collects shared bytes only after every owner ref is removed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arden-managed-object-"))
    const store = makeManagedObjectStore(path.join(root, "managed-outputs"))
    try {
      const first = await store.publish({
        sessionId: "first",
        text: "shared",
        format: "text",
        source: { kind: "tool", name: "x", call_id: "one" }
      })
      const second = await store.attach({ descriptor: first, sessionId: "branch" })
      expect(await store.ownerDigests("first")).toEqual([first.sha256])
      await store.removeOwner("first")
      expect(await store.collectDigest(first.sha256)).toBe(false)
      expect(await store.read({ sessionId: "branch", ref: second.ref })).toBe("shared")
      await store.removeOwner("first")
      await store.removeOwner("branch")
      expect(await store.collectDigest(first.sha256)).toBe(true)
      await expect(store.read({ sessionId: "branch", ref: second.ref })).rejects.toThrow()
      expect(await store.collectDigest(first.sha256)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
