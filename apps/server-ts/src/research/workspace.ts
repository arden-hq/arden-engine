import { formatBytes } from "@arden-hq/std/count"
import path from "node:path"
import { Context, DateTime, Effect, Layer, Option, Schema, Semaphore } from "effect"

import { writeAtomic } from "@arden-hq/std/atomic-file"
import { isErrnoCode } from "../fs/private-store.js"

import {
  emptyResearchState,
  type ResearchCheck,
  type ResearchClaim,
  type ResearchClaimStatus,
  type ResearchEvidence,
  type ResearchSourceSnapshot,
  type ResearchState
} from "./model.js"
import {
  decodeState,
  ensureDirectory,
  readPlainFile,
  researchError,
  storage,
  ResearchWorkspaceError
} from "./workspace-storage.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { decodeOpaque, encodeOpaque } from "../lib/opaque-ref.js"
import { excerptSpan } from "./excerpt-span.js"

const MAX_STATE_BYTES = 5 * 1024 * 1024
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_SOURCE_BYTES = 50 * 1024 * 1024
const MAX_CLAIMS = 1_000
const MAX_SOURCES = 4_000
const MAX_EVIDENCE = 4_000
const MAX_CHECKS = 8_000
const MAX_OPERATIONS = 10_000

const WorkspaceIdSchema = Schema.String.check(Schema.isPattern(/^research-[a-f0-9]{32}$/))
const OperationIdSchema = Schema.String.check(Schema.isUUID(4))

interface ClaimRecordInput {
  readonly workspaceId: string
  readonly expectedRevision: number
  readonly operationId: string
  readonly statement: string
  readonly qualifiers: ReadonlyArray<string>
  readonly asOf: string | null
}

interface EvidenceRecordInput {
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

interface SourceCaptureInput {
  readonly workspaceId: string
  readonly operationId: string
  readonly locator: string
  readonly title: string
  readonly text: string
  readonly publishedAt: string | null
}

interface ClaimCheckInput {
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

interface ResearchVerifierItem {
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

const operationPayloadHash = (value: Readonly<Record<string, unknown>>): string =>
  sha256Hex(JSON.stringify(value))

const aggregateClaimStatus = (checks: ReadonlyArray<ResearchCheck>): ResearchClaimStatus => {
  const supports = checks.some((check) => check.verdict === "supports")
  const contradicts = checks.some((check) => check.verdict === "contradicts")
  if (supports && contradicts) return "mixed"
  if (contradicts) return "contradicted"
  if (supports) return "supported"
  return "insufficient"
}

const CursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

const cursor = (offset: number): string => encodeOpaque({ version: 1, offset })

const cursorOffset = (value: string | undefined): number => {
  if (value === undefined) return 0
  const decoded = Option.getOrUndefined(decodeOpaque(CursorSchema, value))
  if (decoded === undefined) {
    throw researchError("invalid", "Research review cursor is invalid")
  }
  return decoded.offset
}

interface WorkspacePaths {
  readonly directory: string
  readonly state: string
  readonly sources: string
}

interface ResearchWorkspaceShape {
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

export class ResearchWorkspace extends Context.Service<ResearchWorkspace, ResearchWorkspaceShape>()(
  "@arden-hq/server/research/ResearchWorkspace"
) {
  static layer(root: string): Layer.Layer<ResearchWorkspace> {
    return Layer.effect(ResearchWorkspace, makeResearchWorkspace(root))
  }
}

const makeResearchWorkspace = Effect.fn("ResearchWorkspace.make")(function* (root: string) {
  const permits = new Map<string, Semaphore.Semaphore>()

  const validatedId = (workspaceId: string): Effect.Effect<string, ResearchWorkspaceError> =>
    Schema.decodeUnknownEffect(WorkspaceIdSchema)(workspaceId).pipe(
      Effect.mapError((cause) =>
        researchError("invalid", "Research workspace reference is invalid", workspaceId, cause)
      )
    )

  const paths = Effect.fn("ResearchWorkspace.paths")(function* (workspaceId: string) {
    const id = yield* validatedId(workspaceId)
    const directory = path.join(root, id)
    return {
      directory,
      state: path.join(directory, "state.json"),
      sources: path.join(directory, "sources")
    } satisfies WorkspacePaths
  })

  const prepare = Effect.fn("ResearchWorkspace.prepare")(function* (workspaceId: string) {
    const resolved = yield* paths(workspaceId)
    yield* ensureDirectory(root, workspaceId)
    yield* ensureDirectory(resolved.directory, workspaceId)
    yield* ensureDirectory(resolved.sources, workspaceId)
    return resolved
  })

  const readState = Effect.fn("ResearchWorkspace.readState")(function* (workspaceId: string) {
    const resolved = yield* prepare(workspaceId)
    const file = yield* readPlainFile(
      workspaceId,
      resolved.state,
      "Research state could not be read",
      MAX_STATE_BYTES
    ).pipe(
      Effect.catch((failure) =>
        isErrnoCode(failure.cause, "ENOENT") ? Effect.succeed(null) : Effect.fail(failure)
      )
    )
    if (file === null) return { paths: resolved, state: emptyResearchState() }
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
    } catch (cause) {
      return yield* researchError(
        "corrupt",
        "Research state is not valid UTF-8 JSON",
        workspaceId,
        cause
      )
    }
    return { paths: resolved, state: yield* decodeState(workspaceId, raw) }
  })

  const writeState = Effect.fn("ResearchWorkspace.writeState")(function* (
    workspaceId: string,
    paths: WorkspacePaths,
    state: ResearchState
  ) {
    const encoded = Buffer.from(JSON.stringify(state), "utf8")
    if (encoded.byteLength > MAX_STATE_BYTES) {
      return yield* researchError(
        "quota",
        `Research state exceeds its ${formatBytes(MAX_STATE_BYTES)} limit`,
        workspaceId
      )
    }
    yield* storage(workspaceId, "Research state could not be committed", () =>
      writeAtomic(paths.state, encoded)
    )
  })

  const permitFor = (workspaceId: string): Semaphore.Semaphore => {
    const existing = permits.get(workspaceId)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(1)
    permits.set(workspaceId, created)
    return created
  }

  const mutate = <A extends Readonly<Record<string, Schema.Json>>>(input: {
    readonly workspaceId: string
    readonly expectedRevision: number | null
    readonly operationId: string
    readonly payload: Readonly<Record<string, unknown>>
    readonly apply: (
      state: ResearchState,
      paths: WorkspacePaths,
      timestamp: string,
      nextRevision: number
    ) => Effect.Effect<
      { readonly state: ResearchState; readonly result: A },
      ResearchWorkspaceError
    >
  }): Effect.Effect<ResearchMutationReceipt, ResearchWorkspaceError> =>
    permitFor(input.workspaceId).withPermit(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(OperationIdSchema)(input.operationId).pipe(
          Effect.mapError((cause) =>
            researchError("invalid", "Research operation id is invalid", input.workspaceId, cause)
          )
        )
        if (
          input.expectedRevision !== null &&
          (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        ) {
          return yield* researchError("invalid", "Research revision is invalid", input.workspaceId)
        }
        const loaded = yield* readState(input.workspaceId)
        const payloadHash = operationPayloadHash(input.payload)
        const prior = loaded.state.operations.find(
          (operation) => operation.operationId === input.operationId
        )
        if (prior !== undefined) {
          if (prior.payloadHash !== payloadHash) {
            return yield* researchError(
              "conflict",
              "The operation id was already used with a different payload",
              input.workspaceId
            )
          }
          return {
            revision: loaded.state.revision,
            changed: false,
            result: prior.result
          }
        }
        if (input.expectedRevision !== null && input.expectedRevision !== loaded.state.revision) {
          return yield* researchError(
            "conflict",
            `Research state is at revision ${loaded.state.revision}; review it and retry`,
            input.workspaceId
          )
        }
        if (loaded.state.operations.length >= MAX_OPERATIONS) {
          return yield* researchError(
            "quota",
            "Research operation history is full",
            input.workspaceId
          )
        }
        const timestamp = DateTime.formatIso(yield* DateTime.now)
        const nextRevision = loaded.state.revision + 1
        const applied = yield* input.apply(loaded.state, loaded.paths, timestamp, nextRevision)
        const next = {
          ...applied.state,
          revision: nextRevision,
          operations: [
            ...applied.state.operations,
            {
              operationId: input.operationId,
              payloadHash,
              result: applied.result,
              createdAt: timestamp
            }
          ]
        } satisfies ResearchState
        yield* decodeState(input.workspaceId, next)
        yield* writeState(input.workspaceId, loaded.paths, next)
        return { revision: nextRevision, changed: true, result: applied.result }
      })
    )

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

  const persistSource = Effect.fn("ResearchWorkspace.persistSource")(function* (
    workspaceId: string,
    paths: WorkspacePaths,
    bytes: Buffer
  ) {
    const rawHash = sha256Hex(bytes)
    const target = path.join(paths.sources, rawHash)
    const existing = yield* readPlainFile(
      workspaceId,
      target,
      "Research source could not be read",
      MAX_SOURCE_BYTES
    ).pipe(
      Effect.catch((failure) =>
        isErrnoCode(failure.cause, "ENOENT") ? Effect.succeed(null) : Effect.fail(failure)
      )
    )
    if (existing !== null) {
      if (sha256Hex(existing.bytes) !== rawHash) {
        return yield* researchError("corrupt", "Research source hash path is invalid", workspaceId)
      }
      return { rawHash, bytes: bytes.byteLength }
    }

    yield* storage(workspaceId, "Research source could not be stored", () =>
      writeAtomic(target, bytes)
    )
    return { rawHash, bytes: bytes.byteLength }
  })

  const captureSource = Effect.fn("ResearchWorkspace.captureSource")((
    input: SourceCaptureInput
  ) => {
    const normalized = canonicalResearchText(input.text)
    return mutate({
      workspaceId: input.workspaceId,
      expectedRevision: null,
      operationId: input.operationId,
      payload: {
        locator: input.locator,
        title: input.title,
        text: input.text,
        publishedAt: input.publishedAt
      },
      apply: Effect.fn("ResearchWorkspace.captureSource.apply")(
        function* (state, paths, timestamp, nextRevision) {
          if (input.locator.length === 0 || input.locator.length > 8_000) {
            return yield* researchError(
              "invalid",
              "Research source locator is invalid",
              input.workspaceId
            )
          }
          if (input.title.length > 2_000) {
            return yield* researchError(
              "invalid",
              "Research source title is too long",
              input.workspaceId
            )
          }
          if (input.publishedAt !== null && input.publishedAt.length > 128) {
            return yield* researchError(
              "invalid",
              "Research source publication date is too long",
              input.workspaceId
            )
          }
          if (state.sources.length >= MAX_SOURCES) {
            return yield* researchError("quota", "Research source limit reached", input.workspaceId)
          }
          const candidateBytes = Buffer.from(input.text, "utf8")
          if (candidateBytes.byteLength > MAX_SOURCE_BYTES) {
            return yield* researchError(
              "quota",
              `One research source may be at most ${formatBytes(MAX_SOURCE_BYTES)}`,
              input.workspaceId
            )
          }
          const sourceBytes = new Map(state.sources.map((source) => [source.rawHash, source.bytes]))
          sourceBytes.set(sha256Hex(candidateBytes), candidateBytes.byteLength)
          const totalBytes = [...sourceBytes.values()].reduce((total, bytes) => total + bytes, 0)
          if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
            return yield* researchError(
              "quota",
              `Research source storage exceeds ${formatBytes(MAX_TOTAL_SOURCE_BYTES)}`,
              input.workspaceId
            )
          }
          const persisted = yield* persistSource(input.workspaceId, paths, candidateBytes)
          const snapshotRef = `source-${sha256Hex(input.operationId).slice(0, 32)}`
          const snapshot = {
            snapshotRef,
            locator: input.locator,
            title: input.title,
            rawHash: persisted.rawHash,
            canonicalHash: sha256Hex(normalized),
            renderer: "plain-text-v1" as const,
            retrievedAt: timestamp,
            publishedAt: input.publishedAt,
            bytes: persisted.bytes,
            characters: normalized.length
          } satisfies ResearchSourceSnapshot
          return {
            state: { ...state, sources: [...state.sources, snapshot] },
            result: { snapshot_ref: snapshotRef, revision: nextRevision }
          }
        }
      )
    })
  })

  const readSource = Effect.fn("ResearchWorkspace.readSource")(function* (
    workspaceId: string,
    paths: WorkspacePaths,
    snapshot: ResearchSourceSnapshot
  ) {
    const target = path.join(paths.sources, snapshot.rawHash)
    const file = yield* readPlainFile(
      workspaceId,
      target,
      "Research source could not be read",
      MAX_SOURCE_BYTES
    )
    if (file.size !== snapshot.bytes) {
      return yield* researchError("corrupt", "Research source snapshot is invalid", workspaceId)
    }
    if (sha256Hex(file.bytes) !== snapshot.rawHash) {
      return yield* researchError("corrupt", "Research source hash does not match", workspaceId)
    }
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    } catch (cause) {
      return yield* researchError(
        "corrupt",
        "Research source is not valid UTF-8",
        workspaceId,
        cause
      )
    }
    const canonical = canonicalResearchText(text)
    if (sha256Hex(canonical) !== snapshot.canonicalHash) {
      return yield* researchError(
        "corrupt",
        "Research canonical source hash does not match",
        workspaceId
      )
    }
    return canonical
  })

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
                item.claimRef === input.claimRef &&
                ((item.relation === "supports" && input.relation === "contradicts") ||
                  (item.relation === "contradicts" && input.relation === "supports"))
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
