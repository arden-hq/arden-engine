import { readFile } from "node:fs/promises"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  decodeCanonicalJsonl,
  encodeCommitRecord,
  encodeTreeRecord,
  parseCommitRecord,
  parseTreeRecord
} from "../src/domain/codec.js"
import {
  buildTreeObjects,
  canonicalJsonl,
  commitRecord,
  type ChangeRecord,
  type CommitRecord,
  type JsonRecord,
  type VersionRecord
} from "../src/domain/format.js"
import { ResourceChange, ResourceVersion } from "../src/domain/model.js"
import { firstOf, present } from "./kit.js"
import { sha256Hex } from "@arden-hq/std/hash"

type ObjectFixture = {
  readonly id: string
  readonly bytes_hex: string
  readonly sha256: string
}

type CommitFixture = {
  readonly commit_id: string
  readonly parent_id: string | null
  readonly tree_id: string
  readonly actor: string
  readonly origin: string
  readonly reason: string
  readonly timestamp: string
  readonly changes: readonly ChangeRecord[]
}

type HistoryFixture = {
  readonly name: string
  readonly commit: CommitFixture
  readonly resources: readonly VersionRecord[]
}

type Fixture = {
  readonly canonical_jsonl: {
    readonly record: JsonRecord
    readonly bytes_hex: string
    readonly sha256: string
  }
  readonly objects: {
    readonly blob: ObjectFixture
    readonly tree: ObjectFixture
    readonly commit: ObjectFixture
  }
  readonly history: readonly HistoryFixture[]
}

const bytesFromHex = (value: string): Uint8Array => {
  const parts = value.match(/[0-9a-f]{2}/gi)
  if (parts === null || parts.length * 2 !== value.length)
    throw new Error(`invalid hex fixture: ${value}`)
  return Uint8Array.from(parts, (part) => Number.parseInt(part, 16))
}

const resourceVersion = (value: VersionRecord): ResourceVersion =>
  new ResourceVersion({
    resourceId: value.resource_id,
    path: value.path,
    blobId: value.blob_id,
    state: value.state,
    versionId: value.version_id
  })

const resourceChange = (value: ChangeRecord): ResourceChange =>
  new ResourceChange({
    action: value.action,
    before: value.before === null ? null : resourceVersion(value.before),
    after: value.after === null ? null : resourceVersion(value.after)
  })

const commitWireRecord = (value: CommitFixture): CommitRecord =>
  commitRecord({
    parentId: value.parent_id,
    treeId: value.tree_id,
    actor: value.actor,
    origin: value.origin,
    reason: value.reason,
    timestamp: value.timestamp,
    changes: value.changes.map(resourceChange)
  })

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/format-v2.json", import.meta.url), "utf8")
) as Fixture

const firstStep = (): HistoryFixture => firstOf(fixture.history, "history step")

describe("format-v2 golden vectors", () => {
  it("freezes canonical records and content-addressed bytes", () => {
    const bytes = canonicalJsonl(fixture.canonical_jsonl.record)
    expect(bytes).toEqual(bytesFromHex(fixture.canonical_jsonl.bytes_hex))
    expect(sha256Hex(bytes)).toBe(fixture.canonical_jsonl.sha256)

    const blob = bytesFromHex(fixture.objects.blob.bytes_hex)
    expect(sha256Hex(blob)).toBe(fixture.objects.blob.id)
    expect(sha256Hex(blob)).toBe(fixture.objects.blob.sha256)
  })

  it("reproduces every history version, tree, and commit identity", () => {
    for (const step of fixture.history) {
      const resources = step.resources.map(resourceVersion)
      const trees = buildTreeObjects(resources)
      expect(trees.rootId, `${step.name} tree id`).toBe(step.commit.tree_id)

      const tree = present(trees.objects.get(trees.rootId), `${step.name} tree object`)
      expect(sha256Hex(encodeTreeRecord(tree))).toBe(step.commit.tree_id)

      const record = commitWireRecord(step.commit)
      const bytes = encodeCommitRecord(record)
      expect(sha256Hex(bytes), `${step.name} commit id`).toBe(step.commit.commit_id)
      expect(Effect.runSync(parseCommitRecord(record))).toEqual(record)
    }

    const first = firstStep()
    const trees = buildTreeObjects(first.resources.map(resourceVersion))
    const tree = present(trees.objects.get(trees.rootId), "root tree object")
    expect(encodeTreeRecord(tree)).toEqual(bytesFromHex(fixture.objects.tree.bytes_hex))

    const commit = commitWireRecord(first.commit)
    expect(encodeCommitRecord(commit)).toEqual(bytesFromHex(fixture.objects.commit.bytes_hex))
    expect(Effect.runSync(decodeCanonicalJsonl(encodeCommitRecord(commit)))).toEqual(commit)
    expect(Effect.runSync(parseTreeRecord(tree))).toEqual(tree)
  })
})
