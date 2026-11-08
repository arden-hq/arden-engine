import { Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  withExtras,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"
import type { ChatUpdate, CommunicationEnvelope } from "./communication.js"

const IdentifierSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const LabelSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160))
const LineSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500))
const HashSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[a-f0-9]{64}$/.test(value) ? undefined : "must be a lowercase SHA-256 hash"
  )
)

const route = (
  prefixes: readonly string[],
  identity: (door: Readonly<Record<string, unknown>>) => unknown
) =>
  Schema.makeFilter((door: Readonly<Record<string, unknown>>) => {
    const value = identity(door)
    return typeof value === "string" &&
      prefixes.some((prefix) => door.href === `${prefix}${encodeURIComponent(value)}`)
      ? undefined
      : { path: ["href"], issue: "must be the canonical route for this target" }
  })

const TASK_ROUTES = ["arden:task/", "arden:work/"]

export const TaskCommunicationDoorSchema = withExtras({
  kind: Schema.Literal("task"),
  label: LabelSchema,
  item_id: IdentifierSchema,
  href: Schema.String
}).check(route(TASK_ROUTES, (door) => door.item_id))

export const SessionCommunicationDoorSchema = withExtras({
  kind: Schema.Literal("session"),
  label: LabelSchema,
  session_ref: IdentifierSchema,
  href: Schema.String
}).check(route(["arden:session/"], (door) => door.session_ref))

export const AutomationCommunicationDoorSchema = withExtras({
  kind: Schema.Literal("automation"),
  label: LabelSchema,
  automation_ref: IdentifierSchema,
  href: Schema.String
}).check(route(["arden:automation/"], (door) => door.automation_ref))

export const RunCommunicationDoorSchema = withExtras({
  kind: Schema.Literal("run"),
  label: LabelSchema,
  run_id: IdentifierSchema,
  session_ref: IdentifierSchema,
  href: Schema.String
}).check(route(["arden:session/"], (door) => door.session_ref))

export const AutomationRunCommunicationDoorSchema = withExtras({
  kind: Schema.Literal("automation_run"),
  label: LabelSchema,
  automation_ref: IdentifierSchema,
  run_id: IdentifierSchema,
  session_ref: IdentifierSchema,
  href: Schema.String
}).check(route(["arden:session/"], (door) => door.session_ref))

export const ArtifactCommunicationDoorSchema = withExtras({
  kind: Schema.Literal("artifact"),
  label: LabelSchema,
  item_id: IdentifierSchema,
  attachment_id: PositiveIntSchema,
  href: Schema.String
}).check(route(TASK_ROUTES, (door) => door.item_id))

export const CommunicationDoorSchema = Schema.Union([
  TaskCommunicationDoorSchema,
  SessionCommunicationDoorSchema,
  AutomationCommunicationDoorSchema,
  RunCommunicationDoorSchema,
  AutomationRunCommunicationDoorSchema,
  ArtifactCommunicationDoorSchema
]).pipe(Schema.toTaggedUnion("kind"))

export const CommunicationAttentionReferenceSchema = Schema.Union([
  withExtras({ kind: Schema.Literal("question"), question_id: IdentifierSchema }),
  withExtras({ kind: Schema.Literal("approval"), approval_id: IdentifierSchema })
]).pipe(Schema.toTaggedUnion("kind"))

export const ContinuitySourceCursorSchema = withExtras({
  arrivals_through: NonNegativeIntSchema,
  question_changes_through: NonNegativeIntSchema
})

const arrivalBase = {
  arrival_id: IdentifierSchema,
  occurrence_key: IdentifierSchema,
  source_run_id: IdentifierSchema,
  source_session_ref: IdentifierSchema,
  destination_space_id: Schema.NullOr(IdentifierSchema),
  destination_session_ref: IdentifierSchema,
  source_sequence: NonNegativeIntSchema,
  occurred_at: IsoDateTimeStringSchema,
  payload_hash: HashSchema,
  line: LineSchema,
  door: CommunicationDoorSchema
} as const

export const CommunicationArrivalSchema = Schema.Union([
  withExtras({ ...arrivalBase, event: Schema.Literal("finished") }),
  withExtras({ ...arrivalBase, event: Schema.Literal("blocked") }),
  withExtras({
    ...arrivalBase,
    event: Schema.Literal("needs_you"),
    attention: CommunicationAttentionReferenceSchema
  }),
  withExtras({ ...arrivalBase, event: Schema.Literal("failed") }),
  withExtras({ ...arrivalBase, event: Schema.Literal("paused") }),
  withExtras({ ...arrivalBase, event: Schema.Literal("told") }),
  withExtras({ ...arrivalBase, event: Schema.Literal("met") })
]).pipe(Schema.toTaggedUnion("event"))

export const UpdateEventSchema = Schema.Literals([
  "finished",
  "blocked",
  "failed",
  "paused",
  "told",
  "met"
] as const)

export const UpdateDrawnWeightSchema = Schema.Literals(["owed", "news"] as const)

export const ChatUpdateSchema: Schema.Codec<ChatUpdate> = withExtras({
  key: IdentifierSchema,
  weight: UpdateDrawnWeightSchema,
  event: UpdateEventSchema,
  line: Schema.Trim.check(Schema.isMinLength(1)),
  door: CommunicationDoorSchema
})

export const CommunicationEnvelopeSchema: Schema.Codec<CommunicationEnvelope> = Schema.Union([
  withExtras({
    kind: Schema.Literal("arrival"),
    arrival: CommunicationArrivalSchema,
    shown: Schema.optionalKey(Schema.Boolean)
  })
]).pipe(Schema.toTaggedUnion("kind"))
