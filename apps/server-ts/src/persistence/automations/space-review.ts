import { AUTOMATION_TRIGGER_SOURCE } from "@arden-hq/protocol/effect/automations"
import type { AutomationTriggerContext } from "@arden-hq/protocol/automations"
import { Schema } from "effect"
import { RUNS_ALONE } from "./event-batch.js"
import type { SpaceReviewSnapshot } from "./job-prompt.js"

export const REVIEWED_TASK_FIELDS = [
  "text",
  "body",
  "status",
  "owner",
  "blocked",
  "waiting_on",
  "due_at",
  "next_attempt_at"
] as const

export const SPACE_REVIEW_DISPOSITION = {
  no_change: "no_change",
  changed: "changed",
  proposed: "proposed",
  reconciled: "reconciled",
  needs_user: "needs_user"
} as const

const SummarySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)).pipe(
  Schema.annotateEncoded({
    description: "What this review did, in one or two sentences (up to 500 characters)."
  })
)
const IdsSchema = (description: string) =>
  Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)).annotate({ description })
const ProposalIdsSchema = IdsSchema(
  "Every proposal_id task_propose returned in this Run, passed verbatim (task-proposal:…)."
)

export const SpaceReviewDispositionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(SPACE_REVIEW_DISPOSITION.no_change),
    summary: SummarySchema
  }),
  Schema.Struct({
    kind: Schema.Literal(SPACE_REVIEW_DISPOSITION.changed),
    summary: SummarySchema,
    task_ids: IdsSchema("Every Task this Run changed, commented on, or saved a result to.")
  }),
  Schema.Struct({
    kind: Schema.Literal(SPACE_REVIEW_DISPOSITION.proposed),
    summary: SummarySchema,
    proposal_ids: ProposalIdsSchema
  }),
  Schema.Struct({
    kind: Schema.Literal(SPACE_REVIEW_DISPOSITION.reconciled),
    summary: SummarySchema,
    proposal_ids: ProposalIdsSchema
  }),
  Schema.Struct({
    kind: Schema.Literal(SPACE_REVIEW_DISPOSITION.needs_user),
    summary: SummarySchema,
    question_ids: IdsSchema("Every active question this Run created for the user.")
  })
])
export type SpaceReviewDisposition = typeof SpaceReviewDispositionSchema.Type

export const TASK_PROPOSAL_ID_PREFIX = "task-proposal:"

export const canonicalProposalId = (id: string): string => {
  const trimmed = id.trim()
  return trimmed.startsWith(TASK_PROPOSAL_ID_PREFIX)
    ? trimmed
    : `${TASK_PROPOSAL_ID_PREFIX}${trimmed}`
}

export const canonicalDisposition = (
  disposition: SpaceReviewDisposition
): SpaceReviewDisposition =>
  disposition.kind === SPACE_REVIEW_DISPOSITION.proposed ||
  disposition.kind === SPACE_REVIEW_DISPOSITION.reconciled
    ? { ...disposition, proposal_ids: disposition.proposal_ids.map(canonicalProposalId) }
    : disposition

const ChatTurnSchema = Schema.Struct({
  sessionId: Schema.String,
  sessionRef: Schema.String,
  runId: Schema.String,
  turnId: Schema.String
})

const ReviewPageBasisSchema = Schema.Literals(["owned", "source", "linked"])

const ReadPagesSchema = Schema.Array(
  Schema.Struct({
    pageId: Schema.String,
    path: Schema.String,
    version: Schema.String,
    previousVersion: Schema.NullOr(Schema.String),
    basis: ReviewPageBasisSchema
  })
)

const InputPagesSchema = Schema.Array(
  Schema.Struct({
    pageId: Schema.String,
    path: Schema.String,
    version: Schema.String,
    rootPageId: Schema.String,
    basis: ReviewPageBasisSchema
  })
)

const SpaceReviewReadsSchema = Schema.Struct({
  space: Schema.Struct({ name: Schema.String, instructions: Schema.NullOr(Schema.String) }),
  openTasks: Schema.Array(
    Schema.Struct({
      itemId: Schema.String,
      historyRevision: Schema.optionalKey(Schema.NullOr(Schema.String)),
      text: Schema.String,
      status: Schema.String
    })
  ),
  proposals: Schema.Array(Schema.String),
  memory: Schema.Struct({ base: Schema.NullOr(Schema.String), head: Schema.NullOr(Schema.String) }),
  pages: ReadPagesSchema,
  chats: Schema.Array(ChatTurnSchema),
  removed: Schema.Array(Schema.String)
})
export type SpaceReviewReads = typeof SpaceReviewReadsSchema.Type

const SPACE_REVIEW_ADMISSION = {
  changed: "changed",
  unchanged: "unchanged",
  nothingToActOn: "nothing_to_act_on"
} as const

const SpaceReviewAdmissionSchema = Schema.Literals(Object.values(SPACE_REVIEW_ADMISSION))
export type SpaceReviewAdmission = typeof SpaceReviewAdmissionSchema.Type

export const SpaceReviewInputSchema = Schema.Struct({
  admission: SpaceReviewAdmissionSchema,
  spaceId: Schema.String,
  repositoryHead: Schema.NullOr(Schema.String),
  pages: InputPagesSchema,
  chats: Schema.Array(ChatTurnSchema),
  semantic: Schema.String,
  unresolved: Schema.Array(Schema.String),
  reads: Schema.optionalKey(SpaceReviewReadsSchema),
  prompt: Schema.String
})
export type SpaceReviewInput = typeof SpaceReviewInputSchema.Type

export interface SpaceReviewEvidence {
  readonly spaceId: string
  readonly pageId: string | null
  readonly pagePath: string | null
  readonly memorySources: ReadonlyArray<string>
  readonly semantic: string
  readonly chats: SpaceReviewInput["chats"]
  readonly openProposals: ReadonlyArray<string>
  readonly space: SpaceReviewSnapshot | undefined
  readonly reviewed?: SpaceReviewInput
  readonly asked: boolean
}

export const askedByOwner = (trigger: AutomationTriggerContext): boolean =>
  (trigger.source === AUTOMATION_TRIGGER_SOURCE.coalesced ? trigger.causes : [trigger]).some(
    (cause) =>
      cause.source === AUTOMATION_TRIGGER_SOURCE.manual ||
      (cause.source === AUTOMATION_TRIGGER_SOURCE.event && cause.event_type === RUNS_ALONE)
  )
