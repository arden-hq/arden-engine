import { Effect, Option, Schema } from "effect"

import {
  RESEARCH_CHECK_VERDICT,
  type ResearchCheck,
  type ResearchClaim,
  type ResearchClaimStatus,
  type ResearchEvidence,
  type ResearchSourceSnapshot
} from "./model.js"
import { researchError, ResearchWorkspaceError } from "./workspace-storage.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { decodeOpaque, encodeOpaque } from "../lib/opaque-ref.js"

export const MAX_STATE_BYTES = 5 * 1024 * 1024
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024
export const MAX_TOTAL_SOURCE_BYTES = 50 * 1024 * 1024
export const MAX_CLAIMS = 1_000
export const MAX_SOURCES = 4_000
export const MAX_EVIDENCE = 4_000
export const MAX_CHECKS = 8_000
export const MAX_OPERATIONS = 10_000

export const WorkspaceIdSchema = Schema.String.check(Schema.isPattern(/^research-[a-f0-9]{32}$/))
export const OperationIdSchema = Schema.String.check(Schema.isUUID(4))

export interface ClaimRecordInput {
  readonly workspaceId: string
  readonly expectedRevision: number
  readonly operationId: string
  readonly statement: string
  readonly qualifiers: ReadonlyArray<string>
  readonly asOf: string | null
}

export interface EvidenceRecordInput {
  readonly workspaceId: string
  readonly expectedRevision: number
  readonly operationId: string
  readonly claimRef: string
  readonly relation: ResearchEvidence["relation"]
  readonly snapshotRef: string
  readonly start: number
  readonly end: number
  readonly excerpt: string
  readonly note: string | null
}

export interface SourceCaptureInput {
  readonly workspaceId: string
  readonly operationId: string
  readonly locator: string
  readonly title: string
  readonly text: string
  readonly publishedAt: string | null
}

export interface ClaimCheckInput {
  readonly workspaceId: string
  readonly expectedRevision: number
  readonly operationId: string
  readonly checks: ReadonlyArray<Omit<ResearchCheck, "checkRef" | "checkedAt">>
}

export interface ResearchMutationReceipt {
  readonly revision: number
  readonly changed: boolean
  readonly result: Readonly<Record<string, Schema.Json>>
}

export interface ResearchVerifierItem {
  readonly claim: ResearchClaim
  readonly snapshot: ResearchSourceSnapshot
  readonly evidence: Pick<ResearchEvidence, "evidenceRef" | "start" | "end" | "excerpt">
}

export interface ResearchReviewPage {
  readonly revision: number
  readonly claims: ReadonlyArray<
    ResearchClaim & {
      readonly evidence: ReadonlyArray<ResearchEvidence>
      readonly checks: ReadonlyArray<ResearchCheck>
    }
  >
  readonly nextCursor: string | null
}

export const canonicalResearchText = (value: string): string =>
  value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n")

export const operationPayloadHash = (value: Readonly<Record<string, unknown>>): string =>
  sha256Hex(JSON.stringify(value))

export const aggregateClaimStatus = (checks: ReadonlyArray<ResearchCheck>): ResearchClaimStatus => {
  const supports = checks.some((check) => check.verdict === RESEARCH_CHECK_VERDICT.supports)
  const contradicts = checks.some((check) => check.verdict === RESEARCH_CHECK_VERDICT.contradicts)
  if (supports && contradicts) return "mixed"
  if (contradicts) return "contradicted"
  if (supports) return "supported"
  return "insufficient"
}

const CursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

export const cursor = (offset: number): string => encodeOpaque({ version: 1, offset })

export const cursorOffset = (value: string | undefined): number => {
  if (value === undefined) return 0
  const decoded = Option.getOrUndefined(decodeOpaque(CursorSchema, value))
  if (decoded === undefined) {
    throw researchError("invalid", "Research review cursor is invalid")
  }
  return decoded.offset
}

export interface WorkspacePaths {
  readonly directory: string
  readonly state: string
  readonly sources: string
}

export interface ResearchWorkspaceShape {
  readonly captureSource: (
    input: SourceCaptureInput
  ) => Effect.Effect<ResearchMutationReceipt, ResearchWorkspaceError>
  readonly claimRecord: (
    input: ClaimRecordInput
  ) => Effect.Effect<ResearchMutationReceipt, ResearchWorkspaceError>
  readonly evidenceRecord: (
    input: EvidenceRecordInput
  ) => Effect.Effect<ResearchMutationReceipt, ResearchWorkspaceError>
  readonly verifierItems: (
    workspaceId: string,
    claimRefs: ReadonlyArray<string>
  ) => Effect.Effect<
    { readonly revision: number; readonly items: ReadonlyArray<ResearchVerifierItem> },
    ResearchWorkspaceError
  >
  readonly recordChecks: (
    input: ClaimCheckInput
  ) => Effect.Effect<ResearchMutationReceipt, ResearchWorkspaceError>
  readonly review: (
    workspaceId: string,
    options?: {
      readonly statuses?: ReadonlyArray<ResearchClaimStatus>
      readonly cursor?: string
      readonly limit?: number
    }
  ) => Effect.Effect<ResearchReviewPage, ResearchWorkspaceError>
}
