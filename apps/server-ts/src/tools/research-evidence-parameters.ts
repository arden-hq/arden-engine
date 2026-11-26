import { Schema } from "effect"

import { ResearchClaimStatusSchema } from "../research/model.js"

const ExpectedRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ClaimRefSchema = Schema.String.check(Schema.isPattern(/^claim-[a-f0-9]{32}$/))

export const ClaimRecordParametersSchema = Schema.Struct({
  expected_revision: ExpectedRevisionSchema.annotate({
    description:
      "Exact workspace revision: 0 for a fresh workspace, otherwise the revision reported by the latest claim tool result, claim_review, or the workspace revision line on a read result."
  }),
  statement: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)).pipe(
    Schema.annotateEncoded({
      description: "One atomic, qualified, time-scoped claim. Record it before seeking evidence."
    })
  ),
  qualifiers: Schema.optionalKey(
    Schema.Array(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)))
      .check(Schema.isMaxLength(32))
      .annotate({
        description: "Conditions, population, scope, or other qualifiers that must remain attached."
      })
  ),
  as_of: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(128)).annotate({
      description: "Date, version, or time window to which the claim applies."
    })
  )
})

export const EvidenceRecordParametersSchema = Schema.Struct({
  expected_revision: ExpectedRevisionSchema.annotate({
    description:
      "Exact workspace revision: 0 for a fresh workspace, otherwise the revision reported by the latest claim tool result, claim_review, or the workspace revision line on a read result."
  }),
  claim_ref: ClaimRefSchema.annotate({
    description: "Recorded claim to which this source span applies."
  }),
  snapshot_ref: Schema.String.check(Schema.isPattern(/^source-[a-f0-9]{32}$/)).annotate({
    description: "Snapshot reference appended to a successful research read tool result."
  }),
  relation: Schema.Literals(["supports", "contradicts", "qualifies"] as const).annotate({
    description: "Your provisional relation. claim_check independently evaluates it later."
  }),
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "Zero-based start character in canonical text (NFC with LF newlines)."
  }),
  end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "Exclusive end character in canonical text."
  }),
  excerpt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
    description: "Exact source substring selected by start and end."
  }),
  note: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(4_000)).annotate({
      description: "Optional explanation of relevance or scope."
    })
  )
})

export const ClaimCheckParametersSchema = Schema.Struct({
  expected_revision: ExpectedRevisionSchema.annotate({
    description:
      "Exact workspace revision from the latest claim tool result or claim_review. The check fails if the workspace has changed since."
  }),
  claim_refs: Schema.optionalKey(
    Schema.Array(ClaimRefSchema)
      .check(Schema.isMinLength(1), Schema.isMaxLength(50), Schema.isUnique())
      .annotate({
        description: "Claims to check. Omit to check every claim that has recorded evidence."
      })
  )
})

export const ClaimReviewParametersSchema = Schema.Struct({
  statuses: Schema.optionalKey(
    Schema.Array(ResearchClaimStatusSchema)
      .check(Schema.isMinLength(1), Schema.isUnique())
      .annotate({
        description: "Claim statuses to include. Omit to include every status."
      })
  ),
  cursor: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(2_048)).annotate({
      description: "Opaque cursor returned by a previous claim_review call."
    })
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description: "Maximum claims to return, from 1 through 100. Defaults to 20."
    })
  )
})
