import type { AutomationTriggerContext } from "@arden-hq/protocol/automations"
import { Schema } from "effect"
import { RUNS_ALONE } from "./event-batch.js"
import type { SpaceReviewSnapshot } from "./job-prompt.js"

/** The Task fields a Space review compares with its checkpoint, in checkpoint order. */
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
    kind: Schema.Literal("no_change"),
    summary: SummarySchema
  }),
  Schema.Struct({
    kind: Schema.Literal("changed"),
    summary: SummarySchema,
    task_ids: IdsSchema("Every Task this Run changed, commented on, or saved a result to.")
  }),
  Schema.Struct({
    kind: Schema.Literal("proposed"),
    summary: SummarySchema,
    proposal_ids: ProposalIdsSchema
  }),
  Schema.Struct({
    kind: Schema.Literal("reconciled"),
    summary: SummarySchema,
    proposal_ids: ProposalIdsSchema
  }),
  Schema.Struct({
    kind: Schema.Literal("needs_user"),
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
  disposition.kind === "proposed" || disposition.kind === "reconciled"
    ? { ...disposition, proposal_ids: disposition.proposal_ids.map(canonicalProposalId) }
    : disposition

const ChatTurnSchema = Schema.Struct({
  sessionId: Schema.String,
  sessionRef: Schema.String,
  runId: Schema.String,
  turnId: Schema.String
})

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
  pages: Schema.Array(
    Schema.Struct({
      pageId: Schema.String,
      path: Schema.String,
      version: Schema.String,
      basis: Schema.Literals(["owned", "source", "linked", "resident"]),
      previousVersion: Schema.NullOr(Schema.String)
    })
  ),
  chats: Schema.Array(ChatTurnSchema),
  removed: Schema.Array(Schema.String),
  items: Schema.Array(
    Schema.Struct({
      itemId: Schema.String,
      source: Schema.String,
      sender: Schema.NullOr(Schema.String),
      title: Schema.String,
      snippet: Schema.String,
      receivedAt: Schema.String,
      reason: Schema.String,
      isNew: Schema.Boolean
    })
  )
})
export type SpaceReviewReads = typeof SpaceReviewReadsSchema.Type

/**
 * Whether the review starts, from `spaceReviewAdmission`:
 * - `changed`: something it can act on changed, or the owner asked; the review runs.
 * - `unchanged`: nothing changed since the last review; no run.
 * - `nothing_to_act_on`: something changed, but nothing the review can act on; no run.
 */
const SpaceReviewAdmissionSchema = Schema.Literals(["changed", "unchanged", "nothing_to_act_on"])
export type SpaceReviewAdmission = typeof SpaceReviewAdmissionSchema.Type

export const SpaceReviewInputSchema = Schema.Struct({
  admission: SpaceReviewAdmissionSchema,
  spaceId: Schema.String,
  repositoryHead: Schema.NullOr(Schema.String),
  pages: Schema.Array(
    Schema.Struct({
      pageId: Schema.String,
      path: Schema.String,
      version: Schema.String,
      basis: Schema.Literals(["owned", "source", "linked", "resident"]),
      rootPageId: Schema.String
    })
  ),
  chats: Schema.Array(ChatTurnSchema),
  semantic: Schema.String,
  unresolved: Schema.Array(Schema.String),
  items: Schema.optionalKey(Schema.Array(Schema.Struct({ itemId: Schema.String }))),
  reads: Schema.optionalKey(SpaceReviewReadsSchema),
  prompt: Schema.String
})
export type SpaceReviewInput = typeof SpaceReviewInputSchema.Type

export interface SpaceReviewItem {
  readonly itemId: string
  readonly source: string
  readonly sender: string | null
  readonly title: string
  readonly snippet: string
  readonly receivedAt: string
  readonly reason: string
}

export interface SpaceReviewEvidence {
  readonly spaceId: string
  readonly pageId: string | null
  readonly pagePath: string | null
  readonly memorySources: ReadonlyArray<string>
  readonly semantic: string
  readonly chats: SpaceReviewInput["chats"]
  readonly items: ReadonlyArray<SpaceReviewItem>
  readonly openProposals: ReadonlyArray<string>
  readonly space: SpaceReviewSnapshot | undefined
  readonly reviewed?: SpaceReviewInput
  /** The owner asked for this review: `askedByOwner` of the run's trigger. */
  readonly asked: boolean
}

/** The one answer to "did the owner ask for this review": a manual run or a
 * proposal recheck among the run's causes, alone or folded into a coalesced
 * trigger with other waiting rows. */
export const askedByOwner = (trigger: AutomationTriggerContext): boolean =>
  (trigger.source === "coalesced" ? trigger.causes : [trigger]).some(
    (cause) =>
      cause.source === "manual" || (cause.source === "event" && cause.event_type === RUNS_ALONE)
  )
