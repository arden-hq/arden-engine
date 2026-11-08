import type { ToolResult } from "@arden-hq/loop"
import type { ChangeEvidence, ChangeEntry } from "@arden-hq/protocol/chat"
export type { ChangeEvidence, ChangeEntry } from "@arden-hq/protocol/chat"
import type { EffectTargetOrigin } from "../../execution/tool-effect.js"
import {
  boundedLabel,
  boundedPlace,
  mutationOperationId,
  readMutationReceipt,
  receiptResources,
  type ListedResource,
  type MutationOperationIdentity
} from "./mutation-receipt.js"

export interface CallTarget {
  readonly source: string
  readonly objectId: string
  readonly title?: string
  readonly href?: string
  readonly place?: string
  readonly origin: EffectTargetOrigin
}

const targetDomain = (source: string): ChangeEntry["domain"] => {
  switch (source) {
    case "gmail":
    case "gmail_draft":
      return "email"
    case "calendar":
      return "calendar"
    case "google_drive":
      return "document"
    case "command":
    case "browser":
    case "app":
      return source
    default:
      return "other"
  }
}

const versionSide = (version: string): ChangeEntry["before"] =>
  version === "absent" ? { kind: "absent" } : { kind: "version", version }

const entryId = (operationId: string, kind: "resource" | "target", index: number): string =>
  index === 0 ? `${operationId}:${kind}` : `${operationId}:${kind}:${index}`

const resourceEntry = (
  resource: ListedResource,
  outcome: ChangeEntry["outcome"],
  entry_id: string,
  fileComparison: "patch" | "truncated" | "unavailable"
): ChangeEntry => {
  const label = boundedLabel(resource)
  if (resource.kind === "target") {
    return {
      entry_id,
      domain: resource.domain,
      resource_ref: resource.resource_ref,
      ...label,
      outcome,
      before: { kind: "unrecorded" },
      after: { kind: "unrecorded" },
      comparison: "unavailable"
    }
  }
  const file = resource.kind === "file_revision"
  return {
    entry_id,
    domain: resource.domain ?? (file ? "file" : "resource"),
    resource_ref: resource.resource_ref,
    ...label,
    outcome,
    before: versionSide(resource.before_version),
    after: versionSide(resource.after_version),
    comparison: file ? fileComparison : "versions"
  }
}

const targetEntry = (
  target: CallTarget & { readonly title: string },
  outcome: ChangeEntry["outcome"],
  entry_id: string
): ChangeEntry => ({
  entry_id,
  domain: targetDomain(target.source),
  resource_ref: `${target.source}:${target.objectId}`,
  ...boundedLabel(target),
  ...placeOf(target),
  outcome,
  before: target.origin === "created" ? { kind: "absent" } : { kind: "unrecorded" },
  after: { kind: "unrecorded" },
  comparison: "unavailable"
})

const placeOf = (target: CallTarget): { readonly place?: string } => {
  const place = boundedPlace(target.place)
  return place === undefined ? {} : { place }
}

const hasTitle = (target: CallTarget): target is CallTarget & { readonly title: string } =>
  boundedLabel(target).title !== undefined

const ENTRIES_MAX = 100

export const projectChangeEvidence = (input: {
  readonly identity: MutationOperationIdentity
  readonly host: unknown
  readonly entries: ReadonlyArray<ChangeEntry>
  readonly omitted: number
  readonly children: {
    readonly runs: ChangeEvidence["child_runs"]
    readonly truncated: boolean
  }
  readonly fileComparison: "patch" | "truncated" | "unavailable"
  readonly targets: ReadonlyArray<CallTarget>
}): ChangeEvidence => {
  const operationId = mutationOperationId(input.identity)
  const candidate = readMutationReceipt(input.host)
  const receipt =
    candidate?.operation_id === operationId && candidate.receipt_ref === operationId
      ? candidate
      : undefined
  const outcome = receipt?.outcome ?? "unknown"
  const entries = [
    ...input.entries,
    ...(receipt === undefined ? [] : receiptResources(receipt)).map((resource, index) =>
      resourceEntry(
        resource,
        outcome,
        entryId(operationId, "resource", index),
        input.fileComparison
      )
    ),
    ...input.targets.flatMap((target, index) =>
      hasTitle(target) ? [targetEntry(target, outcome, entryId(operationId, "target", index))] : []
    )
  ]
  const omitted = input.omitted + (receipt?.resources_omitted ?? 0)
  return {
    operation_id: operationId,
    run_id: input.identity.runId,
    tool_call_id: input.identity.toolCallId,
    call_outcome: outcome,
    entries: entries.slice(0, ENTRIES_MAX),
    omitted_entries: omitted + Math.max(0, entries.length - ENTRIES_MAX),
    child_runs: input.children.runs,
    child_runs_truncated: input.children.truncated,
    child_evidence: "read_child_work",
    freshness: "snapshot_refresh_on_history_read",
    scope: "originating_call",
    coverage: "linked_only",
    retention: "tool_trace_and_owner_history"
  }
}

export const stripChangeEvidence = (result: ToolResult): ToolResult => {
  if (result.data == null || !("change_evidence" in result.data)) return result
  const { change_evidence: _evidence, ...data } = result.data
  const { data: _data, ...rest } = result
  return { ...rest, ...(Object.keys(data).length === 0 ? {} : { data }) }
}
