import { Schema } from "effect"

const IdentifierSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const TimestampSchema = Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(64))
const HashSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const NaturalSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ResearchClaimStatusSchema = Schema.Literals([
  "open",
  "supported",
  "contradicted",
  "mixed",
  "insufficient",
  "stale"
] as const)

export type ResearchClaimStatus = (typeof ResearchClaimStatusSchema)["Type"]

const ResearchClaimSchema = Schema.Struct({
  claimRef: IdentifierSchema,
  statement: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  qualifiers: Schema.Array(Schema.String.check(Schema.isMaxLength(1_000))),
  asOf: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  status: ResearchClaimStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
})

export type ResearchClaim = (typeof ResearchClaimSchema)["Type"]

const ResearchSourceSnapshotSchema = Schema.Struct({
  snapshotRef: IdentifierSchema,
  locator: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  title: Schema.String.check(Schema.isMaxLength(2_000)),
  rawHash: HashSchema,
  canonicalHash: HashSchema,
  renderer: Schema.Literal("plain-text-v1"),
  retrievedAt: TimestampSchema,
  publishedAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  bytes: NaturalSchema,
  characters: NaturalSchema
})

export type ResearchSourceSnapshot = (typeof ResearchSourceSnapshotSchema)["Type"]

const ResearchEvidenceRelationSchema = Schema.Literals([
  "supports",
  "contradicts",
  "qualifies"
] as const)

const ResearchEvidenceSchema = Schema.Struct({
  evidenceRef: IdentifierSchema,
  claimRef: IdentifierSchema,
  snapshotRef: IdentifierSchema,
  relation: ResearchEvidenceRelationSchema,
  start: NaturalSchema,
  end: NaturalSchema,
  excerpt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  createdAt: TimestampSchema
}).check(
  Schema.makeFilter((evidence) =>
    evidence.end > evidence.start
      ? undefined
      : { path: ["end"], issue: "must be greater than start" }
  )
)

export type ResearchEvidence = (typeof ResearchEvidenceSchema)["Type"]

const ResearchCheckVerdictSchema = Schema.Literals([
  "supports",
  "contradicts",
  "qualifies",
  "irrelevant"
] as const)

const ResearchCheckSchema = Schema.Struct({
  checkRef: IdentifierSchema,
  claimRef: IdentifierSchema,
  snapshotRef: IdentifierSchema,
  evidenceRefs: Schema.Array(IdentifierSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isUnique()
  ),
  verdict: ResearchCheckVerdictSchema,
  rationale: Schema.String.check(Schema.isMaxLength(4_000)),
  verifierInputHash: HashSchema,
  checkedAt: TimestampSchema
})

export type ResearchCheck = (typeof ResearchCheckSchema)["Type"]

const ResearchOperationSchema = Schema.Struct({
  operationId: Schema.String.check(Schema.isUUID(4)),
  payloadHash: HashSchema,
  result: Schema.Record(Schema.String, Schema.Json),
  createdAt: TimestampSchema
})

export const ResearchStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  revision: NaturalSchema,
  claims: Schema.Array(ResearchClaimSchema),
  sources: Schema.Array(ResearchSourceSnapshotSchema),
  evidence: Schema.Array(ResearchEvidenceSchema),
  checks: Schema.Array(ResearchCheckSchema),
  operations: Schema.Array(ResearchOperationSchema)
})

export type ResearchState = (typeof ResearchStateSchema)["Type"]

export const emptyResearchState = (): ResearchState => ({
  version: 1,
  revision: 0,
  claims: [],
  sources: [],
  evidence: [],
  checks: [],
  operations: []
})
