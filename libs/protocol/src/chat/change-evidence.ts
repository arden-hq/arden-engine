import { Schema } from "effect"

export const ReceiptOutcomeSchema = Schema.Literals([
  "applied",
  "no_op",
  "failed",
  "unconfirmed",
  "unknown"
])

/**
 * One side of a change.
 * - "absent": the object did not exist (before a create, after a delete).
 * - "version": the exact version its owner keeps.
 * - "unrecorded": the object existed, but no version was kept — a service
 *   confirmed the change without returning a before or after Arden retains.
 */
const VersionSideSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("absent") }),
  Schema.Struct({ kind: Schema.Literal("version"), version: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("unrecorded") })
])

/** Longest object name an entry carries; producers cut longer names. */
export const CHANGE_ENTRY_TITLE_MAX = 256
/** Longest place an entry carries; producers cut longer places. */
export const CHANGE_ENTRY_PLACE_MAX = 128
/** Longest link an entry carries; producers drop longer links. */
export const CHANGE_ENTRY_HREF_MAX = 2048

/**
 * What a changed thing is. Besides objects, three domains name an action
 * Arden performed whose side effects it cannot list: "command" (a command it
 * ran, and in which folder), "browser" (what it did on a page), "app" (what
 * it did in an app's window). Their entries keep no before or after
 * (`unrecorded`), compare nothing (`unavailable`), and their title is the
 * action in plain words.
 */
export const ChangeEntrySchema = Schema.Struct({
  entry_id: Schema.NonEmptyString,
  domain: Schema.Literals([
    "task",
    "proposal",
    "space",
    "session",
    "automation",
    "file",
    "resource",
    "memory",
    "email",
    "calendar",
    "document",
    "other",
    "command",
    "browser",
    "app"
  ]),
  resource_ref: Schema.NonEmptyString,
  /** The object's name as its owner or service gave it. */
  title: Schema.optionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(CHANGE_ENTRY_TITLE_MAX))
  ),
  /** Where the object opens: an http(s) link the service returned, or an
   *  `arden:` address for an Arden object. */
  href: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(CHANGE_ENTRY_HREF_MAX))),
  /** Where an action happened (a site, a folder, an app), for action domains. */
  place: Schema.optionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(CHANGE_ENTRY_PLACE_MAX))
  ),
  outcome: ReceiptOutcomeSchema,
  before: VersionSideSchema,
  after: VersionSideSchema,
  comparison: Schema.Literals(["versions", "patch", "truncated", "unavailable"])
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
