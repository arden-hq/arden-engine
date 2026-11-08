import { INVALID_ARGUMENTS_OUTCOME } from "@arden-hq/loop"
import type { ToolResult } from "@arden-hq/loop"
import {
  CHANGE_ENTRY_HREF_MAX,
  CHANGE_ENTRY_PLACE_MAX,
  CHANGE_ENTRY_TITLE_MAX,
  ChangeEntrySchema
} from "@arden-hq/protocol/effect/chat"
import { Option, Predicate, Schema } from "effect"
import { ReceiptOutcomeSchema } from "../../execution/tool-effect.js"

const ReceiptIdentifierSchema = Schema.NonEmptyString

const FileRevisionReconciliationSchema = Schema.Struct({
  kind: Schema.Literal("file_revision"),
  absolute_path: ReceiptIdentifierSchema,
  before_version: ReceiptIdentifierSchema,
  after_version: ReceiptIdentifierSchema
})

type ChangeDomain = (typeof ChangeEntrySchema.Type)["domain"]

const RECEIPT_RESOURCES_MAX = 20

const ReceiptResourceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("versioned_resource"),
    resource_ref: ReceiptIdentifierSchema,
    before_version: ReceiptIdentifierSchema,
    after_version: ReceiptIdentifierSchema,
    domain: Schema.optionalKey(ChangeEntrySchema.fields.domain),
    title: ChangeEntrySchema.fields.title,
    href: ChangeEntrySchema.fields.href
  }),
  Schema.Struct({
    kind: Schema.Literal("target"),
    resource_ref: ReceiptIdentifierSchema,
    domain: ChangeEntrySchema.fields.domain,
    title: ChangeEntrySchema.fields.title,
    href: ChangeEntrySchema.fields.href
  })
])
type ReceiptResource = typeof ReceiptResourceSchema.Type

const MutationReceiptV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: ReceiptIdentifierSchema,
  receipt_ref: ReceiptIdentifierSchema,
  outcome: ReceiptOutcomeSchema,
  resource_ref: Schema.NullOr(ReceiptIdentifierSchema),
  before_version: Schema.NullOr(ReceiptIdentifierSchema),
  after_version: Schema.NullOr(ReceiptIdentifierSchema),
  reconcile: Schema.NullOr(FileRevisionReconciliationSchema),
  resource_kind: Schema.optionalKey(Schema.Literal("target")),
  domain: Schema.optionalKey(ChangeEntrySchema.fields.domain),
  title: ChangeEntrySchema.fields.title,
  href: ChangeEntrySchema.fields.href,
  resources: Schema.optionalKey(
    Schema.Array(ReceiptResourceSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(RECEIPT_RESOURCES_MAX)
    )
  ),
  resources_omitted: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
}).check(
  Schema.makeFilter((receipt) => {
    const reconciliation = receipt.reconcile
    if (receipt.resources !== undefined) {
      return receipt.resource_ref === null &&
        receipt.before_version === null &&
        receipt.after_version === null &&
        reconciliation === null &&
        receipt.resource_kind === undefined &&
        receipt.domain === undefined &&
        receipt.title === undefined &&
        receipt.href === undefined
        ? undefined
        : "a receipt that lists its resources keeps no single resource"
    }
    if (receipt.resources_omitted !== undefined) {
      return "only a receipt that lists its resources counts the ones it left out"
    }
    if (receipt.resource_kind === "target") {
      return receipt.resource_ref !== null &&
        receipt.before_version === null &&
        receipt.after_version === null &&
        reconciliation === null &&
        receipt.domain !== undefined
        ? undefined
        : "a target receipt names its resource and domain and keeps no versions"
    }
    if (reconciliation === null) {
      const versions = [receipt.resource_ref, receipt.before_version, receipt.after_version]
      return versions.every((version) => version === null) ||
        versions.every((version) => version !== null)
        ? undefined
        : "resource and version fields must be all present or all absent"
    }
    if (
      receipt.resource_ref !== `file:${reconciliation.absolute_path}` ||
      receipt.before_version !== reconciliation.before_version ||
      receipt.after_version !== reconciliation.after_version
    ) {
      return "file reconciliation must match the receipt resource and versions"
    }
    return undefined
  })
)

export type MutationReceiptV1 = (typeof MutationReceiptV1Schema)["Type"]

export interface MutationOperationIdentity {
  readonly runId: string
  readonly toolCallId: string
}

interface ResourceLabel {
  readonly domain?: ChangeDomain
  readonly title?: string
  readonly href?: string
}

type ArdenResource =
  | ({
      readonly kind: "versioned_resource"
      readonly resourceRef: string
      readonly beforeVersion: string
      readonly afterVersion: string
    } & ResourceLabel)
  | ({
      readonly kind: "target"
      readonly resourceRef: string
      readonly domain: ChangeDomain
    } & Omit<ResourceLabel, "domain">)

type MutationResource =
  | { readonly kind: "none" }
  | ArdenResource
  | { readonly kind: "resources"; readonly resources: ReadonlyArray<ArdenResource> }
  | {
      readonly kind: "file_revision"
      readonly absolutePath: string
      readonly beforeVersion: string
      readonly afterVersion: string
    }

export interface MakeMutationReceiptInput {
  readonly identity: MutationOperationIdentity
  readonly outcome: MutationReceiptV1["outcome"]
  readonly resource: MutationResource
}

const decodeMutationReceipt = Schema.decodeUnknownOption(MutationReceiptV1Schema, {
  onExcessProperty: "error"
})

export const boundedLabel = (label: {
  readonly title?: string | undefined
  readonly href?: string | undefined
}): { readonly title?: string; readonly href?: string } => {
  const title = label.title?.trim().slice(0, CHANGE_ENTRY_TITLE_MAX)
  const href = label.href
  const linkable =
    href !== undefined &&
    href.length <= CHANGE_ENTRY_HREF_MAX &&
    /^(?:https?:\/\/|arden:)\S+$/i.test(href)
  return {
    ...(title === undefined || title === "" ? {} : { title }),
    ...(linkable ? { href } : {})
  }
}

export const boundedPlace = (place: string | undefined): string | undefined => {
  const bounded = place?.trim().slice(0, CHANGE_ENTRY_PLACE_MAX)
  return bounded === undefined || bounded === "" ? undefined : bounded
}

export const mutationOperationId = (identity: MutationOperationIdentity): string =>
  `tool-call:${identity.runId}:${identity.toolCallId}`

export const makeMutationReceipt = (input: MakeMutationReceiptInput): MutationReceiptV1 => {
  const operationId = mutationOperationId(input.identity)
  if (input.resource.kind === "resources") {
    const distinct = [
      ...new Map(input.resource.resources.map((item) => [item.resourceRef, item])).values()
    ]
    if (distinct.length === 0) return makeMutationReceipt({ ...input, resource: { kind: "none" } })
    const omitted = distinct.length - RECEIPT_RESOURCES_MAX
    return {
      version: 1,
      operation_id: operationId,
      receipt_ref: operationId,
      outcome: input.outcome,
      resource_ref: null,
      before_version: null,
      after_version: null,
      reconcile: null,
      resources: distinct.slice(0, RECEIPT_RESOURCES_MAX).map(receiptResource),
      ...(omitted > 0 ? { resources_omitted: omitted } : {})
    }
  }
  if (input.resource.kind === "none") {
    return {
      version: 1,
      operation_id: operationId,
      receipt_ref: operationId,
      outcome: input.outcome,
      resource_ref: null,
      before_version: null,
      after_version: null,
      reconcile: null
    }
  }
  if (input.resource.kind === "versioned_resource") {
    return {
      version: 1,
      operation_id: operationId,
      receipt_ref: operationId,
      outcome: input.outcome,
      resource_ref: input.resource.resourceRef,
      before_version: input.resource.beforeVersion,
      after_version: input.resource.afterVersion,
      reconcile: null,
      ...(input.resource.domain === undefined ? {} : { domain: input.resource.domain }),
      ...boundedLabel(input.resource)
    }
  }
  if (input.resource.kind === "target") {
    return {
      version: 1,
      operation_id: operationId,
      receipt_ref: operationId,
      outcome: input.outcome,
      resource_ref: input.resource.resourceRef,
      before_version: null,
      after_version: null,
      reconcile: null,
      resource_kind: "target",
      domain: input.resource.domain,
      ...boundedLabel(input.resource)
    }
  }
  const resourceRef = `file:${input.resource.absolutePath}`
  return {
    version: 1,
    operation_id: operationId,
    receipt_ref: operationId,
    outcome: input.outcome,
    resource_ref: resourceRef,
    before_version: input.resource.beforeVersion,
    after_version: input.resource.afterVersion,
    reconcile: {
      kind: "file_revision",
      absolute_path: input.resource.absolutePath,
      before_version: input.resource.beforeVersion,
      after_version: input.resource.afterVersion
    }
  }
}

const receiptResource = (resource: ArdenResource): ReceiptResource =>
  resource.kind === "target"
    ? {
        kind: "target",
        resource_ref: resource.resourceRef,
        domain: resource.domain,
        ...boundedLabel(resource)
      }
    : {
        kind: "versioned_resource",
        resource_ref: resource.resourceRef,
        before_version: resource.beforeVersion,
        after_version: resource.afterVersion,
        ...(resource.domain === undefined ? {} : { domain: resource.domain }),
        ...boundedLabel(resource)
      }

export type ListedResource =
  | ReceiptResource
  | {
      readonly kind: "file_revision"
      readonly resource_ref: string
      readonly before_version: string
      readonly after_version: string
      readonly domain?: ChangeDomain
      readonly title?: string
      readonly href?: string
    }

export const receiptResources = (receipt: MutationReceiptV1): ReadonlyArray<ListedResource> => {
  if (receipt.resources !== undefined) return receipt.resources
  const ref = receipt.resource_ref
  if (ref === null) return []
  const label = {
    ...(receipt.domain === undefined ? {} : { domain: receipt.domain }),
    ...(receipt.title === undefined ? {} : { title: receipt.title }),
    ...(receipt.href === undefined ? {} : { href: receipt.href })
  }
  if (receipt.resource_kind === "target") {
    return receipt.domain === undefined
      ? []
      : [{ kind: "target", resource_ref: ref, ...label, domain: receipt.domain }]
  }
  const before = receipt.before_version
  const after = receipt.after_version
  if (before === null || after === null) return []
  const versions = { resource_ref: ref, before_version: before, after_version: after, ...label }
  return [
    receipt.reconcile?.kind === "file_revision"
      ? { kind: "file_revision", ...versions }
      : { kind: "versioned_resource", ...versions }
  ]
}

export const mutationReceiptHost = (
  input: MakeMutationReceiptInput
): Readonly<Record<string, unknown>> => ({
  mutation_receipt: makeMutationReceipt(input)
})

export const readMutationReceipt = (host: unknown): MutationReceiptV1 | undefined => {
  if (!Predicate.isObject(host)) return undefined
  return Option.getOrUndefined(decodeMutationReceipt(host.mutation_receipt))
}

export const attachMutationReceipt = (
  result: ToolResult,
  input: MakeMutationReceiptInput
): ToolResult => ({
  ...result,
  host: {
    ...(result.host ?? {}),
    ...mutationReceiptHost(input)
  }
})

export const NOT_RUN_HOST = { not_run: "approval" } as const

export const ensureMutationReceipt = (
  identity: MutationOperationIdentity,
  result: ToolResult
): ToolResult => {
  const expectedOperationId = mutationOperationId(identity)
  const receipt = readMutationReceipt(result.host)
  if (
    receipt !== undefined &&
    receipt.operation_id === expectedOperationId &&
    receipt.receipt_ref === expectedOperationId
  ) {
    return result
  }
  return attachMutationReceipt(result, {
    identity,
    outcome:
      result.data?.["outcome"] === INVALID_ARGUMENTS_OUTCOME ||
      result.host?.["not_run"] === NOT_RUN_HOST.not_run
        ? "no_op"
        : "unknown",
    resource: { kind: "none" }
  })
}
