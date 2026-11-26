import { Effect } from "effect"

import { opposingRelations, type ResearchCheck, type ResearchEvidence } from "./model.js"
import { researchError, type ResearchWorkspaceError } from "./workspace-storage.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { excerptSpan } from "./excerpt-span.js"
import {
  MAX_EVIDENCE,
  MAX_CHECKS,
  type EvidenceRecordInput,
  type ClaimCheckInput,
  type ResearchVerifierItem,
  aggregateClaimStatus,
  type ResearchMutationReceipt
} from "./workspace-model.js"
import { type WorkspaceState } from "./workspace-state.js"
import { type WorkspaceSources } from "./workspace-sources.js"

export interface WorkspaceEvidence {
  readonly evidenceRecord: (
    input: EvidenceRecordInput
  ) => Effect.Effect<ResearchMutationReceipt, ResearchWorkspaceError>
  readonly verifierItems: (
    workspaceId: string,
    claimRefs: ReadonlyArray<string>
  ) => Effect.Effect<
    { readonly revision: number; readonly items: Array<ResearchVerifierItem> },
    ResearchWorkspaceError
  >
  readonly recordChecks: (
    input: ClaimCheckInput
  ) => Effect.Effect<ResearchMutationReceipt, ResearchWorkspaceError>
}

export const makeWorkspaceEvidence = ({
  mutate,
  readSource,
  readState
}: {
  readonly mutate: WorkspaceState["mutate"]
  readonly readSource: WorkspaceSources["readSource"]
  readonly readState: WorkspaceState["readState"]
}): WorkspaceEvidence => {
  const evidenceRecord = Effect.fn("ResearchWorkspace.evidenceRecord")((
    input: EvidenceRecordInput
  ) => {
    return mutate({
      ...input,
      payload: {
        claimRef: input.claimRef,
        relation: input.relation,
        snapshotRef: input.snapshotRef,
        start: input.start,
        end: input.end,
        excerpt: input.excerpt,
        note: input.note
      },
      apply: Effect.fn("ResearchWorkspace.evidenceRecord.apply")(
        function* (state, paths, timestamp, nextRevision) {
          if (!state.claims.some((claim) => claim.claimRef === input.claimRef)) {
            return yield* researchError(
              "not_found",
              "Claim was not found; record it first",
              input.workspaceId
            )
          }
          if (state.evidence.length >= MAX_EVIDENCE) {
            return yield* researchError(
              "quota",
              "Research evidence limit reached",
              input.workspaceId
            )
          }
          const snapshot = state.sources.find((source) => source.snapshotRef === input.snapshotRef)
          if (snapshot === undefined) {
            return yield* researchError(
              "not_found",
              "Source snapshot was not found; read the source again in this research agent",
              input.workspaceId
            )
          }
          const normalized = yield* readSource(input.workspaceId, paths, snapshot)
          const span = excerptSpan(normalized, input)
          if (span === undefined) {
            return yield* researchError(
              "invalid",
              "The excerpt does not occur in the canonical source text; copy it exactly from the source read",
              input.workspaceId
            )
          }
          const evidenceRef = `evidence-${sha256Hex(input.operationId).slice(0, 32)}`
          const evidence = {
            evidenceRef,
            claimRef: input.claimRef,
            snapshotRef: input.snapshotRef,
            relation: input.relation,
            start: span.start,
            end: span.end,
            excerpt: input.excerpt,
            note: input.note,
            createdAt: timestamp
          } satisfies ResearchEvidence
          const conflicts = state.evidence
            .filter(
              (item) =>
                item.claimRef === input.claimRef && opposingRelations(item.relation, input.relation)
            )
            .map((item) => item.evidenceRef)
          return {
            state: {
              ...state,
              evidence: [...state.evidence, evidence]
            },
            result: {
              evidence_ref: evidenceRef,
              snapshot_ref: input.snapshotRef,
              conflicts,
              revision: nextRevision
            }
          }
        }
      )
    })
  })

  const verifierItems = Effect.fn("ResearchWorkspace.verifierItems")(function* (
    workspaceId: string,
    claimRefs: ReadonlyArray<string>
  ) {
    const loaded = yield* readState(workspaceId)
    const selected =
      claimRefs.length === 0
        ? loaded.state.claims
        : claimRefs.map((claimRef) =>
            loaded.state.claims.find((claim) => claim.claimRef === claimRef)
          )
    if (selected.some((claim) => claim === undefined)) {
      return yield* researchError("not_found", "One or more claims were not found", workspaceId)
    }
    const items: ResearchVerifierItem[] = []
    for (const claim of selected) {
      if (claim === undefined) continue
      const snapshotRefs = new Set(
        loaded.state.evidence
          .filter((evidence) => evidence.claimRef === claim.claimRef)
          .map((evidence) => evidence.snapshotRef)
      )
      for (const snapshotRef of snapshotRefs) {
        const snapshot = loaded.state.sources.find((source) => source.snapshotRef === snapshotRef)
        if (snapshot === undefined) {
          return yield* researchError(
            "corrupt",
            "Evidence points to a missing source snapshot",
            workspaceId
          )
        }
        const sourceText = yield* readSource(workspaceId, loaded.paths, snapshot)
        const evidence = loaded.state.evidence.filter(
          (evidence) => evidence.claimRef === claim.claimRef && evidence.snapshotRef === snapshotRef
        )
        for (const item of evidence) {
          if (sourceText.slice(item.start, item.end) !== item.excerpt) {
            return yield* researchError(
              "corrupt",
              "Evidence span no longer matches its source",
              workspaceId
            )
          }
          items.push({
            claim,
            snapshot,
            evidence: {
              evidenceRef: item.evidenceRef,
              start: item.start,
              end: item.end,
              excerpt: item.excerpt
            }
          })
          if (items.length > 50) {
            return yield* researchError(
              "quota",
              "More than 50 evidence spans were selected; check fewer claims at once",
              workspaceId
            )
          }
        }
      }
    }
    return { revision: loaded.state.revision, items }
  })

  const recordChecks = Effect.fn("ResearchWorkspace.recordChecks")((input: ClaimCheckInput) =>
    mutate({
      ...input,
      payload: { checks: input.checks },
      apply: Effect.fn("ResearchWorkspace.recordChecks.apply")(
        function* (state, _paths, timestamp, nextRevision) {
          if (state.checks.length + input.checks.length > MAX_CHECKS) {
            return yield* researchError("quota", "Research check limit reached", input.workspaceId)
          }
          const added = input.checks.map((check, index): ResearchCheck => ({
            ...check,
            checkRef: `check-${sha256Hex(`${input.operationId}:${index}`).slice(0, 32)}`,
            checkedAt: timestamp
          }))
          for (const check of added) {
            if (!state.claims.some((claim) => claim.claimRef === check.claimRef)) {
              return yield* researchError(
                "not_found",
                "Checked claim was not found",
                input.workspaceId
              )
            }
            if (!state.sources.some((source) => source.snapshotRef === check.snapshotRef)) {
              return yield* researchError(
                "not_found",
                "Checked source snapshot was not found",
                input.workspaceId
              )
            }
            if (
              check.evidenceRefs.some(
                (evidenceRef) =>
                  !state.evidence.some(
                    (evidence) =>
                      evidence.evidenceRef === evidenceRef &&
                      evidence.claimRef === check.claimRef &&
                      evidence.snapshotRef === check.snapshotRef
                  )
              )
            ) {
              return yield* researchError(
                "not_found",
                "Checked evidence span was not found for this claim and source",
                input.workspaceId
              )
            }
          }
          const allChecks = [...state.checks, ...added]
          const checkedClaimRefs = new Set(added.map((check) => check.claimRef))
          const claims = state.claims.map((claim) =>
            checkedClaimRefs.has(claim.claimRef)
              ? {
                  ...claim,
                  status: aggregateClaimStatus(
                    allChecks.filter((check) => check.claimRef === claim.claimRef)
                  ),
                  updatedAt: timestamp
                }
              : claim
          )
          return {
            state: { ...state, claims, checks: allChecks },
            result: {
              checked: added.length,
              claims: claims
                .filter((claim) => checkedClaimRefs.has(claim.claimRef))
                .map((claim) => ({ claim_ref: claim.claimRef, status: claim.status })),
              revision: nextRevision
            }
          }
        }
      )
    })
  )
  return { evidenceRecord, verifierItems, recordChecks }
}
