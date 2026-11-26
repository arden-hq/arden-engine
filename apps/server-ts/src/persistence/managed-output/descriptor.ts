import {
  MANAGED_OBJECT_HASH,
  MANAGED_REF_KIND,
  readManagedObjectRef,
  type ManagedObjectAddress
} from "./ref.js"

export type ManagedObjectSource =
  | { readonly kind: "tool"; readonly name: string; readonly call_id: string }
  | { readonly kind: "workflow"; readonly workflow_ref: string; readonly attempt: number }

export interface ManagedObjectDescriptor {
  readonly kind: "managed_output"
  readonly ref: string
  readonly sha256: string
  readonly bytes: number
  readonly format: "text" | "json"
  readonly owner_session_hash: string
  readonly source: ManagedObjectSource
}

export const managedObjectRefParts = (ref: string): ManagedObjectAddress | undefined => {
  const read = readManagedObjectRef(ref)
  return read.kind === MANAGED_REF_KIND.managed
    ? { owner: read.owner, digest: read.digest, format: read.format }
    : undefined
}

export const readManagedObjectDescriptor = (
  value: unknown
): ManagedObjectDescriptor | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "managed_output" ||
    !("ref" in value) ||
    typeof value.ref !== "string" ||
    !("sha256" in value) ||
    typeof value.sha256 !== "string" ||
    !MANAGED_OBJECT_HASH.test(value.sha256) ||
    !("bytes" in value) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    !("format" in value) ||
    (value.format !== "text" && value.format !== "json") ||
    !("owner_session_hash" in value) ||
    typeof value.owner_session_hash !== "string" ||
    !MANAGED_OBJECT_HASH.test(value.owner_session_hash) ||
    !("source" in value) ||
    !isManagedObjectSource(value.source)
  )
    return undefined
  const parsed = managedObjectRefParts(value.ref)
  if (
    parsed === undefined ||
    parsed.owner !== value.owner_session_hash ||
    parsed.digest !== value.sha256 ||
    parsed.format !== value.format
  )
    return undefined
  return {
    kind: "managed_output",
    ref: value.ref,
    sha256: value.sha256,
    bytes: value.bytes,
    format: value.format,
    owner_session_hash: value.owner_session_hash,
    source: value.source
  }
}

export const isManagedObjectSource = (value: unknown): value is ManagedObjectSource => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false
  if (value.kind === "tool") {
    return (
      "name" in value &&
      typeof value.name === "string" &&
      value.name.length > 0 &&
      "call_id" in value &&
      typeof value.call_id === "string" &&
      value.call_id.length > 0
    )
  }
  return (
    value.kind === "workflow" &&
    "workflow_ref" in value &&
    typeof value.workflow_ref === "string" &&
    value.workflow_ref.length > 0 &&
    "attempt" in value &&
    typeof value.attempt === "number" &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt >= 1
  )
}
