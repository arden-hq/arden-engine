import { sha256Hex } from "@arden-hq/std/hash"
import { canonicalJson, compareCodePoints } from "@arden-hq/std/json"

import type { ChangeAction, ResourceChange, ResourceState, ResourceVersion } from "./model.js"

type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonRecord = { readonly [key: string]: JsonValue }

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export const encodeUtf8 = (value: string): Uint8Array => encoder.encode(value)

export const decodeUtf8 = (value: Uint8Array): string => decoder.decode(value)

const assertSafeIntegers = (value: JsonValue): void => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new TypeError("revision records support only safe integers")
  } else if (Array.isArray(value)) {
    value.forEach(assertSafeIntegers)
  } else if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(assertSafeIntegers)
  }
}

export const canonicalJsonl = (value: JsonRecord): Uint8Array => {
  assertSafeIntegers(value)
  return encodeUtf8(`${canonicalJson(value, { lenient: true })}\n`)
}

export const OBJECT_KIND = { blob: "blob", tree: "tree", commit: "commit" } as const
export type ObjectKind = (typeof OBJECT_KIND)[keyof typeof OBJECT_KIND]
export const OBJECT_KINDS: ReadonlyArray<ObjectKind> = Object.values(OBJECT_KIND)

export const TREE_ENTRY_KIND = { resource: "resource", subtree: "subtree" } as const

export interface VersionRecord {
  readonly resource_id: string
  readonly path: string
  readonly blob_id: string
  readonly state: ResourceState
  readonly version_id: string
}

export interface ChangeRecord {
  readonly action: ChangeAction
  readonly before: VersionRecord | null
  readonly after: VersionRecord | null
}

export interface CommitRecord {
  readonly version: 2
  readonly kind: typeof OBJECT_KIND.commit
  readonly parent_id: string | null
  readonly tree_id: string
  readonly actor: string
  readonly origin: string
  readonly reason: string
  readonly timestamp: string
  readonly changes: readonly ChangeRecord[]
}

interface TreeResourceRecord {
  readonly kind: typeof TREE_ENTRY_KIND.resource
  readonly name: string
  readonly resource_id: string
  readonly blob_id: string
  readonly state: ResourceState
  readonly version_id: string
}

interface TreeSubtreeRecord {
  readonly kind: typeof TREE_ENTRY_KIND.subtree
  readonly name: string
  readonly tree_id: string
}

export type TreeEntryRecord = TreeResourceRecord | TreeSubtreeRecord

export interface TreeRecord {
  readonly version: 2
  readonly kind: typeof OBJECT_KIND.tree
  readonly entries: readonly TreeEntryRecord[]
}

export interface TreeObjects {
  readonly rootId: string
  readonly objects: ReadonlyMap<string, TreeRecord>
}

const versionRecord = (value: ResourceVersion): VersionRecord => ({
  resource_id: value.resourceId,
  path: value.path,
  blob_id: value.blobId,
  state: value.state,
  version_id: value.versionId
})

const changeRecord = (value: ResourceChange): ChangeRecord => ({
  action: value.action,
  before: value.before === null ? null : versionRecord(value.before),
  after: value.after === null ? null : versionRecord(value.after)
})

export const commitRecord = (value: {
  readonly parentId: string | null
  readonly treeId: string
  readonly actor: string
  readonly origin: string
  readonly reason: string
  readonly timestamp: string
  readonly changes: readonly ResourceChange[]
}): CommitRecord => ({
  version: 2,
  kind: OBJECT_KIND.commit,
  parent_id: value.parentId,
  tree_id: value.treeId,
  actor: value.actor,
  origin: value.origin,
  reason: value.reason,
  timestamp: value.timestamp,
  changes: value.changes.map(changeRecord)
})

export const treeEntrySortKey = (entry: TreeEntryRecord): string =>
  `${entry.name}\u0000${entry.kind}\u0000${entry.kind === TREE_ENTRY_KIND.resource ? entry.resource_id : entry.tree_id}`

const buildTreeNode = (
  items: readonly (readonly [readonly string[], ResourceVersion])[],
  objects: Map<string, TreeRecord>
): string => {
  const resources: TreeResourceRecord[] = []
  const children = new Map<string, Array<readonly [readonly string[], ResourceVersion]>>()
  for (const [[name, ...rest], resource] of items) {
    if (name === undefined) continue
    if (rest.length === 0) {
      resources.push({
        kind: TREE_ENTRY_KIND.resource,
        name,
        resource_id: resource.resourceId,
        blob_id: resource.blobId,
        state: resource.state,
        version_id: resource.versionId
      })
    } else {
      const child = children.get(name)
      if (child === undefined) children.set(name, [[rest, resource]])
      else child.push([rest, resource])
    }
  }
  const entries: TreeEntryRecord[] = [...resources]
  for (const [name, childItems] of children) {
    entries.push({
      kind: TREE_ENTRY_KIND.subtree,
      name,
      tree_id: buildTreeNode(childItems, objects)
    })
  }
  entries.sort((left, right) => {
    const leftKey = treeEntrySortKey(left)
    const rightKey = treeEntrySortKey(right)
    return compareCodePoints(leftKey, rightKey)
  })
  const record: TreeRecord = { version: 2, kind: OBJECT_KIND.tree, entries }
  const treeId = sha256Hex(canonicalJsonl(record as unknown as JsonRecord))
  objects.set(treeId, record)
  return treeId
}

export const buildTreeObjects = (resources: readonly ResourceVersion[]): TreeObjects => {
  const objects = new Map<string, TreeRecord>()
  const items = resources.map((resource) => [resource.path.split("/"), resource] as const)
  return { rootId: buildTreeNode(items, objects), objects }
}
