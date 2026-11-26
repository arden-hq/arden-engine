import { Context, Effect, Layer } from "effect"

import { type ResearchClaim, type ResearchClaimStatus } from "./model.js"
import { researchError, ResearchWorkspaceError } from "./workspace-storage.js"
import { sha256Hex } from "@arden-hq/std/hash"
import {
  MAX_CLAIMS,
  type ClaimRecordInput,
  cursor,
  cursorOffset,
  type ResearchWorkspaceShape
} from "./workspace-model.js"
import { makeWorkspaceState } from "./workspace-state.js"
import { makeWorkspaceSources } from "./workspace-sources.js"
import { makeWorkspaceEvidence } from "./workspace-evidence.js"

export class ResearchWorkspace extends Context.Service<ResearchWorkspace, ResearchWorkspaceShape>()(
  "@arden-hq/server/research/ResearchWorkspace"
) {
  static layer(root: string): Layer.Layer<ResearchWorkspace> {
    return Layer.effect(ResearchWorkspace, makeResearchWorkspace(root))
  }
}

const makeResearchWorkspace = Effect.fn("ResearchWorkspace.make")(function* (root: string) {
  const { readState, mutate } = makeWorkspaceState(root)
  const claimRecord = Effect.fn("ResearchWorkspace.claimRecord")((input: ClaimRecordInput) => {
    const statement = input.statement.trim()
    const qualifiers = input.qualifiers
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    return mutate({
      ...input,
      payload: { statement, qualifiers, asOf: input.asOf },
      apply: Effect.fn("ResearchWorkspace.claimRecord.apply")(
        function* (state, _paths, timestamp, nextRevision) {
          if (statement.length === 0) {
            return yield* researchError(
              "invalid",
              "Claim statement must not be empty",
              input.workspaceId
            )
          }
          if (state.claims.length >= MAX_CLAIMS) {
            return yield* researchError("quota", "Research claim limit reached", input.workspaceId)
          }
          const claimRef = `claim-${sha256Hex(input.operationId).slice(0, 32)}`
          const claim = {
            claimRef,
            statement,
            qualifiers,
            asOf: input.asOf,
            status: "open" as const,
            createdAt: timestamp,
            updatedAt: timestamp
          } satisfies ResearchClaim
          return {
            state: { ...state, claims: [...state.claims, claim] },
            result: { claim_ref: claimRef, revision: nextRevision }
          }
        }
      )
    })
  })

  const { captureSource, readSource } = makeWorkspaceSources({ mutate })
  const { evidenceRecord, verifierItems, recordChecks } = makeWorkspaceEvidence({
    mutate,
    readSource,
    readState
  })
  const review = Effect.fn("ResearchWorkspace.review")(function* (
    workspaceId: string,
    options: {
      readonly statuses?: ReadonlyArray<ResearchClaimStatus>
      readonly cursor?: string
      readonly limit?: number
    } = {}
  ) {
    const loaded = yield* readState(workspaceId)
    const limit = options.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return yield* researchError(
        "invalid",
        "Research review limit must be between 1 and 100",
        workspaceId
      )
    }
    let offset: number
    try {
      offset = cursorOffset(options.cursor)
    } catch (cause) {
      return yield* cause instanceof ResearchWorkspaceError
        ? cause
        : researchError("invalid", "Research review cursor is invalid", workspaceId, cause)
    }
    const statuses = options.statuses === undefined ? null : new Set(options.statuses)
    const filtered = loaded.state.claims.filter((claim) => statuses?.has(claim.status) ?? true)
    const page = filtered.slice(offset, offset + limit)
    return {
      revision: loaded.state.revision,
      claims: page.map((claim) => ({
        ...claim,
        evidence: loaded.state.evidence.filter((evidence) => evidence.claimRef === claim.claimRef),
        checks: loaded.state.checks.filter((check) => check.claimRef === claim.claimRef)
      })),
      nextCursor: offset + page.length < filtered.length ? cursor(offset + page.length) : null
    }
  })

  return ResearchWorkspace.of({
    captureSource,
    claimRecord,
    evidenceRecord,
    verifierItems,
    recordChecks,
    review
  })
})

export const researchWorkspaceId = (rootSessionId: string): string =>
  `research-${sha256Hex(rootSessionId).slice(0, 32)}`
