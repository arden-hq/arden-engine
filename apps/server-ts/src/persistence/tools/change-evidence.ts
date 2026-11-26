import type { ToolResult } from "@arden-hq/loop"
import {
  CHANGE_ENTRY_DOMAIN,
  CHANGE_ENTRY_LINK,
  CHANGE_ENTRY_PLACE,
  CHANGE_ENTRY_VERSION,
  CHANGE_ENTRY_TITLE,
  type ChangeEvidence,
  type ChangeEntry
} from "@arden-hq/protocol/chat"
export type { ChangeEvidence, ChangeEntry } from "@arden-hq/protocol/chat"
import type { EffectTargetOrigin } from "../../execution/tool-effect.js"
import {
  boundedLabel,
  boundedPlace,
  MUTATION_RESOURCE,
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

const TARGET_DOMAIN: ReadonlyMap<string, ChangeEntry["domain"]> = new Map([
  ["gmail", CHANGE_ENTRY_DOMAIN.email],
  ["gmail_draft", CHANGE_ENTRY_DOMAIN.email],
  ["calendar", CHANGE_ENTRY_DOMAIN.calendar],
  ["mac_calendar", CHANGE_ENTRY_DOMAIN.calendar],
  ["google_drive", CHANGE_ENTRY_DOMAIN.document],
  ["command", CHANGE_ENTRY_DOMAIN.command],
  ["browser", CHANGE_ENTRY_DOMAIN.browser],
  ["app", CHANGE_ENTRY_DOMAIN.app]
])

const targetDomain = (source: string): ChangeEntry["domain"] =>
  TARGET_DOMAIN.get(source) ?? CHANGE_ENTRY_DOMAIN.other

const BEFORE_OF_ORIGIN: Readonly<Record<EffectTargetOrigin, ChangeEntry["before"]>> = {
  created: { kind: CHANGE_ENTRY_VERSION.absent },
  named: { kind: CHANGE_ENTRY_VERSION.unrecorded }
}

const versionSide = (version: string): ChangeEntry["before"] =>
  version === CHANGE_ENTRY_VERSION.absent
    ? { kind: CHANGE_ENTRY_VERSION.absent }
    : { kind: CHANGE_ENTRY_VERSION.version, version }

const entryId = (operationId: string, kind: "resource" | "target", index: number): string =>
  index === 0 ? `${operationId}:${kind}` : `${operationId}:${kind}:${index}`

const entryLabel = (label: {
  readonly title?: string
  readonly href?: string
}): Pick<ChangeEntry, "title" | "link"> => {
  const bounded = boundedLabel(label)
  return {
    title:
      bounded.title === undefined
        ? { kind: CHANGE_ENTRY_TITLE.untitled }
        : { kind: CHANGE_ENTRY_TITLE.titled, text: bounded.title },
    link:
      bounded.href === undefined
        ? { kind: CHANGE_ENTRY_LINK.unlinked }
        : { kind: CHANGE_ENTRY_LINK.linked, href: bounded.href }
  }
}

const unplaced: ChangeEntry["place"] = { kind: CHANGE_ENTRY_PLACE.unplaced }

const resourceEntry = (
  resource: ListedResource,
  outcome: ChangeEntry["outcome"],
  entry_id: string,
  fileComparison: "patch" | "truncated" | "unavailable"
): ChangeEntry => {
  const label = entryLabel(resource)
  if (resource.kind === MUTATION_RESOURCE.target) {
    return {
      entry_id,
      domain: resource.domain,
      resource_ref: resource.resource_ref,
      ...label,
      place: unplaced,
      outcome,
      before: { kind: "unrecorded" },
      after: { kind: "unrecorded" },
      comparison: "unavailable"
    }
  }
  const file = resource.kind === MUTATION_RESOURCE.file_revision
  return {
    entry_id,
    domain: resource.domain ?? (file ? "file" : "resource"),
    resource_ref: resource.resource_ref,
    ...label,
    place: unplaced,
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
  ...entryLabel(target),
  place: placeOf(target),
  outcome,
  before: BEFORE_OF_ORIGIN[target.origin],
  after: { kind: "unrecorded" },
  comparison: "unavailable"
})

const placeOf = (target: CallTarget): ChangeEntry["place"] => {
  const place = boundedPlace(target.place)
  return place === undefined ? unplaced : { kind: CHANGE_ENTRY_PLACE.placed, place }
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
