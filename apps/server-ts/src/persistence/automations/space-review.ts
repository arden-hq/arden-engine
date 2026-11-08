import { Schema } from "effect"
import type { SpaceReviewSnapshot } from "./job-prompt.js"

export const SpaceReviewDispositionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("no_change"),
    summary: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500))
  }),
  Schema.Struct({
    kind: Schema.Literal("changed"),
    summary: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    task_ids: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))
  }),
  Schema.Struct({
    kind: Schema.Literal("proposed"),
    summary: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    proposal_ids: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))
  }),
  Schema.Struct({
    kind: Schema.Literal("reconciled"),
    summary: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    proposal_ids: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))
  }),
  Schema.Struct({
    kind: Schema.Literal("needs_user"),
    summary: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    question_ids: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))
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

export const SpaceReviewInputSchema = Schema.Struct({
  admission: Schema.Literals(["changed", "unchanged"]),
  spaceId: Schema.String,
  fingerprint: Schema.String,
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

export type ChangedChatTurn = SpaceReviewReads["chats"][number]

export interface GateTurn {
  readonly sessionId: string
  readonly startedAt: string
  readonly chatTitle: string | undefined
  readonly user: string | undefined
  readonly assistant: string | undefined
}

export interface SpaceReviewGateEvidence {
  readonly wokenBy: ReadonlyArray<string>
  readonly heldSince: string | undefined
  readonly turns: ReadonlyArray<GateTurn>
  readonly unread: number
}

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
}
