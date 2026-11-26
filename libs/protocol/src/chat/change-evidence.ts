import { Schema } from "effect"

export const CHANGE_ENTRY_OUTCOME = {
  applied: "applied",
  noOp: "no_op",
  failed: "failed",
  unconfirmed: "unconfirmed",
  unknown: "unknown"
} as const

export type ChangeEntryOutcome = (typeof CHANGE_ENTRY_OUTCOME)[keyof typeof CHANGE_ENTRY_OUTCOME]

export const ReceiptOutcomeSchema = Schema.Literals(Object.values(CHANGE_ENTRY_OUTCOME))

export const CHANGE_ENTRY_VERSION = {
  absent: "absent",
  version: "version",
  unrecorded: "unrecorded"
} as const

const VersionSideSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(CHANGE_ENTRY_VERSION.absent) }),
  Schema.Struct({
    kind: Schema.Literal(CHANGE_ENTRY_VERSION.version),
    version: Schema.NonEmptyString
  }),
  Schema.Struct({ kind: Schema.Literal(CHANGE_ENTRY_VERSION.unrecorded) })
])

export const CHANGE_ENTRY_TITLE_MAX = 256
export const CHANGE_ENTRY_PLACE_MAX = 128
export const CHANGE_ENTRY_HREF_MAX = 2048

export const CHANGE_ENTRY_TITLE = { untitled: "untitled", titled: "titled" } as const

const ChangeEntryTitleSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(CHANGE_ENTRY_TITLE.untitled) }),
  Schema.Struct({
    kind: Schema.Literal(CHANGE_ENTRY_TITLE.titled),
    text: Schema.NonEmptyString.check(Schema.isMaxLength(CHANGE_ENTRY_TITLE_MAX))
  })
])

export const CHANGE_ENTRY_LINK = { unlinked: "unlinked", linked: "linked" } as const

const ChangeEntryLinkSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(CHANGE_ENTRY_LINK.unlinked) }),
  Schema.Struct({
    kind: Schema.Literal(CHANGE_ENTRY_LINK.linked),
    href: Schema.NonEmptyString.check(Schema.isMaxLength(CHANGE_ENTRY_HREF_MAX))
  })
])

export const CHANGE_ENTRY_PLACE = { unplaced: "unplaced", placed: "placed" } as const

const ChangeEntryPlaceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(CHANGE_ENTRY_PLACE.unplaced) }),
  Schema.Struct({
    kind: Schema.Literal(CHANGE_ENTRY_PLACE.placed),
    place: Schema.NonEmptyString.check(Schema.isMaxLength(CHANGE_ENTRY_PLACE_MAX))
  })
])

export type ChangeEntryTitle = typeof ChangeEntryTitleSchema.Type
export type ChangeEntryLink = typeof ChangeEntryLinkSchema.Type
export type ChangeEntryPlace = typeof ChangeEntryPlaceSchema.Type

export const CHANGE_ENTRY_DOMAIN = {
  task: "task",
  proposal: "proposal",
  space: "space",
  session: "session",
  automation: "automation",
  file: "file",
  resource: "resource",
  memory: "memory",
  email: "email",
  calendar: "calendar",
  document: "document",
  other: "other",
  command: "command",
  browser: "browser",
  app: "app"
} as const

export type ChangeEntryDomain = (typeof CHANGE_ENTRY_DOMAIN)[keyof typeof CHANGE_ENTRY_DOMAIN]

export const CHANGE_ENTRY_COMPARISON = {
  versions: "versions",
  patch: "patch",
  truncated: "truncated",
  unavailable: "unavailable"
} as const

export type ChangeEntryComparison =
  (typeof CHANGE_ENTRY_COMPARISON)[keyof typeof CHANGE_ENTRY_COMPARISON]

export const ChangeEntrySchema = Schema.Struct({
  entry_id: Schema.NonEmptyString,
  domain: Schema.Literals(Object.values(CHANGE_ENTRY_DOMAIN)),
  resource_ref: Schema.NonEmptyString,
  title: ChangeEntryTitleSchema,
  link: ChangeEntryLinkSchema,
  place: ChangeEntryPlaceSchema,
  outcome: ReceiptOutcomeSchema,
  before: VersionSideSchema,
  after: VersionSideSchema,
  comparison: Schema.Literals(Object.values(CHANGE_ENTRY_COMPARISON))
})
export type ChangeEntry = typeof ChangeEntrySchema.Type

const ChildRunSchema = Schema.Struct({
  run_id: Schema.NonEmptyString,
  session_id: Schema.NonEmptyString,
  parent_run_id: Schema.NonEmptyString,
  parent_tool_call_id: Schema.NonEmptyString,
  status: Schema.NonEmptyString
})

export const ChangeEvidenceSchema = Schema.Struct({
  operation_id: Schema.NonEmptyString,
  run_id: Schema.NonEmptyString,
  tool_call_id: Schema.NonEmptyString,
  call_outcome: ReceiptOutcomeSchema,
  entries: Schema.Array(ChangeEntrySchema).check(Schema.isMaxLength(100)),
  omitted_entries: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  child_runs: Schema.Array(ChildRunSchema).check(Schema.isMaxLength(100)),
  child_runs_truncated: Schema.Boolean,
  child_evidence: Schema.Literal("read_child_work"),
  freshness: Schema.Literal("snapshot_refresh_on_history_read"),
  scope: Schema.Literal("originating_call"),
  coverage: Schema.Literal("linked_only"),
  retention: Schema.Literal("tool_trace_and_owner_history")
})
export type ChangeEvidence = typeof ChangeEvidenceSchema.Type
