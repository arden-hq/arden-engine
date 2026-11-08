import { captureMutationVersions } from "./mutation-links.js"
import type { SqlClient } from "effect/unstable/sql"
import { readRecordedHistory } from "./recorded-history.js"
import type {
  TaskProposal,
  TaskProposalCapturePolicy,
  TaskProposalRetirement,
  TaskProposalScope
} from "@arden-hq/protocol/proposals"
import {
  ResolveTaskProposalInputSchema,
  TaskProposalCapturePolicySchema,
  TaskProposalSchema
} from "@arden-hq/protocol/effect/proposals"
import {
  SpaceTaskCaptureInputSchema,
  SpaceTaskSchema,
  SpaceTaskSourceSchema,
  decodeCreateSpaceTaskInputEffect
} from "@arden-hq/protocol/effect/spaces/work"
import { RunContextSchema } from "@arden-hq/protocol/effect/runs"
import { DateTime, Effect, Schema } from "effect"
import {
  TaskProposalStore,
  TaskProposalStoreError,
  type ProposeSpaceTaskInput,
  type TaskProposalSettlementAuthority
} from "../proposals/store.js"
import { TaskProposalConflictError } from "../proposals/conflict.js"
import { TASK_PROPOSAL_ID_PREFIX } from "../automations/space-review.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { routeItem } from "./connection-item-route.js"
import { nextId, type Writer } from "./deps.js"
import { decodeJson } from "./json.js"
import { openHeldOnHome } from "./proposal-room.js"
import { homeTaskBody, writeHomeSuggestion } from "./task-proposal-home.js"
import { makeWorkCaptureSql } from "./work-capture.js"
import { makeWorkEvents } from "./work-events.js"
import { assertHomeProposalAdmission, assertInferenceAdmission } from "./work-inference.js"
import { sourceIdentity, sourceRevision, normalized, evidenceKey } from "./proposal-evidence.js"
import { retireProposal } from "./proposal-retirement.js"
import { pruneChatLinks } from "./space-chat-links.js"
import { projectRetirements } from "./proposal-retirement-view.js"
import { isOrdinaryChat } from "./in-chat-task.js"
import { makeProposalRevision, proposalHash } from "./proposal-revision.js"
import { userChatSql } from "./chat-ownership.js"
import { openProposalStatusList } from "./status-sets.js"

export interface ProposalRow {
  readonly proposal_id: string
  readonly place: "space" | "chat" | "home"
  readonly space_id: string | null
  readonly chat_session_id: string | null
  readonly dedupe_key: string
  readonly stable_key: string
  readonly text: string
  readonly body: string | null
  readonly owner: "worker" | "user" | "external"
  readonly capture_json: string
  readonly sources_json: string
  readonly signal_json: string | null
  readonly evidence_revision_key: string
  readonly candidate_hash: string
  readonly source_run_id: string | null
  readonly source_session_id: string | null
  readonly source_turn_id: string | null
  readonly source_tool_call_id: string | null
  readonly capture_policy_json: string | null
  readonly revision: number
  readonly seq: number
  readonly status: "held" | "offered" | "accepted" | "rejected" | "retired"
  readonly retirement_json: string | null
  readonly item_id: string | null
  readonly settlement_client_id: string | null
  readonly settlement_decision: string | null
  readonly settlement_task_json: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly settled_at: string | null
}

const SignalSnapshotSchema = Schema.Struct({
  source: Schema.NonEmptyString,
  title: Schema.String,
  from: Schema.NullOr(Schema.String)
})

const HOME_SETTLED_LISTED_DAYS = 1

const failure = (
  reason: TaskProposalStoreError["reason"],
  message: string,
  cause?: unknown
): TaskProposalStoreError =>
  new TaskProposalStoreError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const canonicalizeSources = (
  sources: ReadonlyArray<typeof SpaceTaskSourceSchema.Type>
): Effect.Effect<ReadonlyArray<typeof SpaceTaskSourceSchema.Type>, TaskProposalStoreError> => {
  const byIdentity = new Map<string, typeof SpaceTaskSourceSchema.Type>()
  for (const source of sources) {
    const identity = sourceIdentity(source)
    const prior = byIdentity.get(identity)
    if (prior !== undefined && sourceRevision(prior) !== sourceRevision(source)) {
      return Effect.fail(
        failure("invalid", "Task proposal evidence contains conflicting revisions for one source")
      )
    }
    byIdentity.set(identity, source)
  }
  return Effect.succeed(
    [...byIdentity.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, source]) => source)
  )
}

export const makeTaskProposalStore = (options: {
  readonly reader: SqlClient.SqlClient
  readonly writer: Writer
  readonly sessionEvents: SessionLifecycleEvents["Service"]
}): Omit<TaskProposalStore["Service"], "requestProposalReview" | "proposalReviewStatus"> => {
  const { writer, sessionEvents } = options
  const sql = writer.sql
  const work = makeWorkCaptureSql({
    writer,
    sessionEvents,
    ...makeWorkEvents(sql, sessionEvents)
  })

  const corrupt = (cause: unknown) => failure("storage", "Stored Task proposal is corrupt", cause)

  const project = Effect.fn("TaskProposal.project")(function* (
    row: ProposalRow,
    known?: ReadonlyMap<string, TaskProposalRetirement>
  ): Effect.fn.Return<TaskProposal, TaskProposalStoreError> {
    const capture = yield* decodeJson(SpaceTaskCaptureInputSchema, row.capture_json).pipe(
      Effect.mapError(corrupt)
    )
    const sources = yield* decodeJson(Schema.Array(SpaceTaskSourceSchema), row.sources_json).pipe(
      Effect.mapError(corrupt)
    )
    const signal =
      row.signal_json === null
        ? null
        : yield* decodeJson(SignalSnapshotSchema, row.signal_json).pipe(Effect.mapError(corrupt))
    const capturePolicy =
      row.capture_policy_json === null
        ? null
        : yield* decodeJson(TaskProposalCapturePolicySchema, row.capture_policy_json).pipe(
            Effect.mapError(corrupt)
          )
    const retirement =
      row.retirement_json === null
        ? null
        : ((known ?? (yield* projectRetirements(sql, [row]))).get(row.proposal_id) ?? {
            reason: "",
            evidence: []
          })
    return yield* Schema.decodeUnknownEffect(TaskProposalSchema)({
      proposal_id: row.proposal_id,
      place: row.place,
      space_id: row.space_id,
      chat_session_id: row.chat_session_id,
      stable_key: row.stable_key,
      text: row.text,
      body: row.body,
      owner: row.owner,
      capture,
      sources,
      signal:
        signal === null ? null : { source: signal.source, title: signal.title, from: signal.from },
      source_run_id: row.source_run_id,
      source_session_id: row.source_session_id,
      source_turn_id: row.source_turn_id,
      source_tool_call_id: row.source_tool_call_id,
      capture_policy: capturePolicy,
      revision: row.revision,
      status: row.status,
      retirement,
      item_id: row.item_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      settled_at: row.settled_at
    }).pipe(Effect.mapError(corrupt))
  })

  const read = Effect.fn("TaskProposal.read")(function* (
    proposalId: string
  ): Effect.fn.Return<ProposalRow, TaskProposalStoreError> {
    const rows = yield* sql<ProposalRow>`SELECT * FROM task_proposals
      WHERE proposal_id = ${proposalId}`.pipe(
      Effect.mapError((cause) => failure("storage", "Could not read Task proposal", cause))
    )
    const row = rows[0]
    if (row === undefined) return yield* failure("not_found", "Task proposal not found")
    return row
  })

  const changed = (row: ProposalRow) =>
    row.space_id === null ? Effect.void : pruneChatLinks(sql, row.space_id)

  const listed = (scope: TaskProposalScope, since: string) => {
    switch (scope.place) {
      case "space":
        return sql<ProposalRow>`SELECT * FROM task_proposals
          WHERE place = 'space' AND space_id = ${scope.spaceId}
          ORDER BY updated_at DESC, proposal_id`
      case "chat":
        return sql<ProposalRow>`SELECT * FROM task_proposals
          WHERE place = 'chat' AND chat_session_id = ${scope.sessionId}
          ORDER BY updated_at DESC, proposal_id`
      case "home":
        return sql<ProposalRow>`SELECT * FROM task_proposals
          WHERE place = 'home' AND (status IN ${openProposalStatusList} OR settled_at >= ${since})
          ORDER BY status = 'offered' DESC, status = 'held' DESC, seq DESC`
    }
  }

  const list: TaskProposalStore["Service"]["list"] = Effect.fn("TaskProposal.list")(
    function* (scope) {
      const since = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { days: HOME_SETTLED_LISTED_DAYS })
      )
      const rows = yield* listed(scope, since)
      const retirements = yield* projectRetirements(sql, rows)
      return { proposals: yield* Effect.forEach(rows, (row) => project(row, retirements)) }
    },
    Effect.mapError((cause) =>
      cause instanceof TaskProposalStoreError
        ? cause
        : failure("storage", "Could not list Task proposals", cause)
    )
  )

  const get: TaskProposalStore["Service"]["get"] = Effect.fn("TaskProposal.get")(
    function* (proposalId) {
      const rows = yield* sql<ProposalRow>`SELECT * FROM task_proposals
        WHERE proposal_id = ${proposalId}`
      return rows[0] === undefined ? undefined : yield* project(rows[0])
    },
    Effect.mapError((cause) =>
      cause instanceof TaskProposalStoreError
        ? cause
        : failure("storage", "Could not read Task proposal", cause)
    )
  )

  const propose: TaskProposalStore["Service"]["propose"] = Effect.fn("TaskProposal.propose")(
    function* (request: ProposeSpaceTaskInput) {
      const input = yield* decodeCreateSpaceTaskInputEffect(request.input).pipe(
        Effect.mapError((cause) => failure("invalid", "Invalid proposed Task", cause))
      )
      const taskCapture = yield* Schema.decodeUnknownEffect(SpaceTaskCaptureInputSchema)(
        request.capture,
        { onExcessProperty: "error" }
      ).pipe(Effect.mapError((cause) => failure("invalid", "Invalid proposed Task capture", cause)))
      if (taskCapture.basis !== "inferred") {
        return yield* failure("invalid", "Task proposals require inferred capture")
      }
      const decodedSources = yield* Schema.decodeUnknownEffect(Schema.Array(SpaceTaskSourceSchema))(
        request.sources,
        { onExcessProperty: "error" }
      ).pipe(
        Effect.mapError((cause) => failure("invalid", "Invalid proposed Task evidence", cause))
      )
      if (decodedSources.length === 0) {
        return yield* failure("invalid", "Task proposals require source evidence")
      }
      const sources = yield* canonicalizeSources(decodedSources)
      const identities = normalized(sources, sourceIdentity)
      const place = request.spaceId === undefined ? "home" : "space"
      const dedupeKey = proposalHash([request.spaceId ?? place, input.key, identities])
      const proposalId = `${TASK_PROPOSAL_ID_PREFIX}${dedupeKey}`
      const evidenceRevisionKey = evidenceKey(sources)
      const owner = input.owner ?? "worker"
      const candidateHash = proposalHash({
        stable_key: input.key,
        text: input.text,
        body: input.body ?? null,
        owner,
        capture: taskCapture,
        sources
      })
      const now = DateTime.formatIso(yield* DateTime.now)

      return yield* writer.transact(
        Effect.gen(function* () {
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "proposal",
            id: proposalId,
            identity: { runId: request.runId, toolCallId: request.toolCallId }
          })
          const existingRows = yield* sql<
            ProposalRow & { readonly retired_evidence_key: string | null }
          >`SELECT *,
            json_extract(retirement_json, '$.evidence_revision_key') AS retired_evidence_key FROM task_proposals
          WHERE proposal_id = ${proposalId}`
          const existing = existingRows[0]
          if (
            existing?.status === "accepted" ||
            (existing?.status === "retired" &&
              (existing.evidence_revision_key === evidenceRevisionKey ||
                existing.retired_evidence_key === evidenceRevisionKey))
          ) {
            return yield* project(existing)
          }
          if (
            existing?.status === "rejected" &&
            existing.evidence_revision_key === evidenceRevisionKey
          ) {
            return yield* project(existing)
          }
          if (existing?.status === "offered" && existing.candidate_hash === candidateHash) {
            return yield* project(existing)
          }
          yield* (
            request.spaceId === undefined
              ? assertHomeProposalAdmission(sql, { runId: request.runId, sources, proposalId })
              : assertInferenceAdmission(sql, {
                  spaceId: request.spaceId,
                  runId: request.runId,
                  snapshot: request.inferenceSnapshot,
                  sources,
                  proposalId
                })
          ).pipe(Effect.mapError((error) => failure(error.reason, error.message, error)))
          const runRows = yield* sql<{
            readonly session_id: string
            readonly turn_id: string | null
            readonly context_json: string
          }>`SELECT session_id,
          json_extract(metadata_json, '$.turn_id') AS turn_id,
          json_extract(metadata_json, '$.run_context') AS context_json
          FROM chat_runs WHERE run_id = ${request.runId}`
          const run = runRows[0]
          if (run === undefined || run.session_id !== request.sessionId || run.turn_id === null) {
            return yield* failure("invalid", "Task proposal source identity is not the active Run")
          }
          const context = yield* decodeJson(RunContextSchema, run.context_json).pipe(
            Effect.mapError((cause) =>
              failure("storage", "Task proposal Run context is corrupt", cause)
            )
          )
          const capturePolicy: TaskProposalCapturePolicy = {
            origin: context.origin.kind,
            task_item_id: context.task?.item_id ?? null,
            task_generation: context.task?.generation ?? null
          }
          const revision = existing === undefined ? 0 : existing.revision + 1
          const createdAt = existing?.created_at ?? now
          const signals = yield* sql<{ readonly signal: string }>`SELECT json_object(
              'source', item.source, 'account', item.account, 'thread_key', item.thread_key,
              'title', item.title, 'from', item.sender) AS signal
            FROM json_each(${JSON.stringify(sources)}) AS cited
            JOIN connection_items AS item ON item.item_id = json_extract(cited.value, '$.item_id')
            WHERE json_extract(cited.value, '$.kind') = 'connection_item'
            ORDER BY cited.key LIMIT 1`
          yield* sql`INSERT INTO task_proposals (
          proposal_id, place, space_id, dedupe_key, stable_key, text, body, owner,
          capture_json, sources_json, signal_json, evidence_revision_key, candidate_hash,
          source_run_id, source_session_id, source_turn_id, source_tool_call_id,
          capture_policy_json, revision, seq, status, item_id, settlement_client_id,
          settlement_decision, settlement_task_json, created_at, updated_at, settled_at
        ) VALUES (
          ${proposalId}, ${place}, ${request.spaceId ?? null}, ${dedupeKey}, ${input.key}, ${input.text},
          ${input.body ?? null}, ${owner}, ${JSON.stringify(taskCapture)},
          ${JSON.stringify(sources)}, ${signals[0]?.signal ?? null}, ${evidenceRevisionKey},
          ${candidateHash}, ${request.runId}, ${request.sessionId}, ${run.turn_id},
          ${request.toolCallId}, ${JSON.stringify(capturePolicy)}, ${revision},
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_proposals), 'offered', NULL, NULL, NULL,
          NULL, ${createdAt}, ${now}, NULL
        ) ON CONFLICT(proposal_id) DO UPDATE SET
          stable_key = excluded.stable_key,
          text = excluded.text,
          body = excluded.body,
          owner = excluded.owner,
          capture_json = excluded.capture_json,
          sources_json = excluded.sources_json,
          signal_json = excluded.signal_json,
          evidence_revision_key = excluded.evidence_revision_key,
          candidate_hash = excluded.candidate_hash,
          source_run_id = excluded.source_run_id,
          source_session_id = excluded.source_session_id,
          source_turn_id = excluded.source_turn_id,
          source_tool_call_id = excluded.source_tool_call_id,
          capture_policy_json = excluded.capture_policy_json,
          revision = excluded.revision,
          status = 'offered',
          item_id = NULL,
          settlement_client_id = NULL,
          settlement_decision = NULL,
          settlement_task_json = NULL,
          updated_at = excluded.updated_at,
          settled_at = NULL, retirement_json = NULL`
          const row = yield* read(proposalId)
          const proposal = yield* project(row)
          yield* changed(row)
          yield* recordVersions
          return proposal
        })
      )
    },
    Effect.mapError((cause) =>
      cause instanceof TaskProposalStoreError
        ? cause
        : failure("storage", "Could not record Task proposal", cause)
    )
  )

  const revise = makeProposalRevision({
    writer,
    sql,
    canonicalizeSources,
    read,
    project,
    changed: (row) =>
      changed(row).pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          failure("storage", "Could not record Task proposal change", cause)
        )
      )
  })

  const suggestFromItem: TaskProposalStore["Service"]["suggestFromItem"] = Effect.fn(
    "TaskProposal.suggestFromItem"
  )(
    function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now)
      const proposalId = `offer_${yield* nextId}`
      return yield* writer.transact(
        Effect.gen(function* () {
          const written = yield* writeHomeSuggestion(sql, { ...input, proposalId, now })
          return written ? yield* read(proposalId).pipe(Effect.flatMap(project)) : undefined
        })
      )
    },
    Effect.mapError((cause) =>
      cause instanceof TaskProposalStoreError
        ? cause
        : failure("storage", "Could not record the Home suggestion", cause)
    )
  )

  const validateStoredSources = Effect.fn("TaskProposal.validateSources")(function* (
    spaceId: string,
    sources: ReadonlyArray<typeof SpaceTaskSourceSchema.Type>,
    authority: TaskProposalSettlementAuthority
  ) {
    for (const source of sources) {
      if (source.kind === "chat") {
        const available = yield* sql`SELECT 1 FROM sessions AS session
          JOIN chat_runs AS run ON run.session_id = session.session_id
          WHERE session.space_id = ${spaceId} AND session.session_id = ${source.session_id}
            AND ${userChatSql("session")}
            AND session.archived_at IS NULL
            AND json_extract(run.metadata_json, '$.turn_id') = ${source.turn_id}
            AND ${source.revision} = ${source.turn_id}
          LIMIT 1`
        if (available.length === 0) {
          return yield* new TaskProposalConflictError({
            kind: "source_unavailable",
            message: "Task proposal evidence is no longer available"
          })
        }
      } else if (source.kind === "connection_item") {
        const owned = yield* sql`SELECT 1 FROM connection_items
          WHERE item_id = ${source.item_id} AND owner_space_id = ${spaceId}`
        if (owned.length === 0) {
          return yield* new TaskProposalConflictError({
            kind: "source_unavailable",
            message: "That item moved off this Space or expired"
          })
        }
      } else if (
        source.kind === "memory" &&
        !authority.memory.some(
          (candidate) =>
            candidate.page_ref === source.page_ref && candidate.revision === source.revision
        )
      ) {
        return yield* new TaskProposalConflictError({
          kind: "source_changed",
          message: "Task proposal Memory evidence changed or left this Space"
        })
      }
    }
  })

  const startOnSpace = Effect.fn("TaskProposal.startOnSpace")(function* (
    row: ProposalRow,
    spaceId: string,
    picked: string | undefined,
    authority: TaskProposalSettlementAuthority
  ) {
    if (picked !== undefined && picked !== spaceId)
      return yield* failure("invalid", "A Space's proposal starts on that Space")
    const spaces = yield* sql`SELECT 1 FROM spaces
      WHERE space_id = ${spaceId} AND archived_at IS NULL`
    if (spaces.length === 0) {
      return yield* new TaskProposalConflictError({
        kind: "space_unavailable",
        message: "This Space is no longer available"
      })
    }
    const authoringSources = yield* sql`SELECT 1
      FROM sessions AS session
      JOIN chat_runs AS run ON run.session_id = session.session_id
      WHERE session.session_id = ${row.source_session_id}
        AND session.space_id = ${spaceId}
        AND session.archived_at IS NULL
        AND run.run_id = ${row.source_run_id}
        AND json_extract(run.metadata_json, '$.turn_id') = ${row.source_turn_id}
      LIMIT 1`
    if (authoringSources.length === 0) {
      return yield* new TaskProposalConflictError({
        kind: "source_unavailable",
        message: "The Task proposal source is no longer available"
      })
    }
    const sources = yield* decodeJson(Schema.Array(SpaceTaskSourceSchema), row.sources_json)
    yield* validateStoredSources(spaceId, sources, authority)
    return yield* work.createInTransaction({
      scope: { kind: "space", spaceId },
      input: { key: row.stable_key, text: row.text, body: row.body, owner: row.owner },
      actor: "user",
      taskSources: sources,
      capture: yield* decodeJson(SpaceTaskCaptureInputSchema, row.capture_json),
      settledInference: true,
      reuseExisting: true
    })
  })

  const startFromHome = Effect.fn("TaskProposal.startFromHome")(function* (
    row: ProposalRow,
    spaceId: string | undefined,
    now: string
  ) {
    if (spaceId === undefined) return yield* failure("invalid", "Pick the Space to start it on")
    const spaces = yield* sql<{ readonly name: string }>`SELECT name FROM spaces
      WHERE space_id = ${spaceId} AND archived_at IS NULL`
    const space = spaces[0]
    if (space === undefined) {
      return yield* new TaskProposalConflictError({
        kind: "space_unavailable",
        message: "That Space is archived"
      })
    }
    const kept = yield* sql<{ readonly item_id: string }>`SELECT item.item_id
      FROM json_each(${row.sources_json}) AS cited
      JOIN connection_items AS item ON item.item_id = json_extract(cited.value, '$.item_id')
      WHERE json_extract(cited.value, '$.kind') = 'connection_item' LIMIT 1`
    const itemId = kept[0]?.item_id
    const capture = yield* decodeJson(SpaceTaskCaptureInputSchema, row.capture_json)
    const input = { key: row.stable_key, text: row.text, body: row.body, owner: row.owner }
    const task =
      row.source_run_id !== null
        ? yield* work.createInTransaction({
            scope: { kind: "space", spaceId },
            input,
            actor: "user",
            taskSources: yield* decodeJson(Schema.Array(SpaceTaskSourceSchema), row.sources_json),
            capture,
            settledInference: true,
            reuseExisting: true
          })
        : yield* work.createInTransaction({
            scope: { kind: "space", spaceId },
            input: {
              ...input,
              body:
                row.body ??
                homeTaskBody(
                  capture.reason,
                  row.signal_json === null
                    ? ""
                    : (yield* decodeJson(SignalSnapshotSchema, row.signal_json)).title
                )
            },
            actor: "user",
            taskSources:
              itemId === undefined
                ? []
                : [{ kind: "connection_item", item_id: itemId, revision: itemId }],
            capture: { basis: "explicit", reason: "You started it from an offer on Home." },
            reuseExisting: true
          })
    if (itemId !== undefined)
      yield* routeItem(sql, {
        itemId,
        spaceId,
        basis: "user",
        reason: `You started it on ${space.name}.`,
        now
      })
    return task
  })

  const resolve: TaskProposalStore["Service"]["resolve"] = Effect.fn("TaskProposal.resolve")(
    function* (proposalId, request, authority) {
      const input = yield* Schema.decodeUnknownEffect(ResolveTaskProposalInputSchema)(request, {
        onExcessProperty: "error"
      }).pipe(
        Effect.mapError((cause) => failure("invalid", "Invalid Task proposal decision", cause))
      )
      const now = DateTime.formatIso(yield* DateTime.now)
      return yield* writer.transact(
        Effect.gen(function* () {
          const row = yield* read(proposalId)
          if (row.status === "retired")
            return yield* new TaskProposalConflictError({
              kind: "settled",
              message: "This proposal was retired after its evidence was reviewed"
            })
          if (row.status === "accepted" || row.status === "rejected") {
            if (
              row.settlement_client_id !== input.client_id ||
              row.settlement_decision !== input.decision
            ) {
              return yield* new TaskProposalConflictError({
                kind: "settled",
                message: "This Task proposal was already resolved differently"
              })
            }
            const proposal = yield* project(row)
            if (row.settlement_task_json === null) return { proposal, task: null }
            return {
              proposal,
              task: yield* decodeJson(
                Schema.Record(Schema.String, Schema.Json),
                row.settlement_task_json
              )
                .pipe(
                  Effect.flatMap((saved) =>
                    Schema.decodeUnknownEffect(SpaceTaskSchema)({
                      history_revision: null,
                      ...saved
                    })
                  )
                )
                .pipe(
                  Effect.mapError((cause) =>
                    failure("storage", "Accepted Task proposal receipt is corrupt", cause)
                  )
                )
            }
          }
          if (row.status === "held")
            return yield* new TaskProposalConflictError({
              kind: "not_offered",
              message: "This suggestion is not open yet"
            })
          if (row.revision !== input.expected_revision) {
            return yield* new TaskProposalConflictError({
              kind: "proposal_changed",
              message: "This Task proposal changed; review it again"
            })
          }
          if (input.decision === "reject") {
            yield* sql`UPDATE task_proposals SET
            status = 'rejected', settlement_client_id = ${input.client_id},
            settlement_decision = 'reject', updated_at = ${now}, settled_at = ${now}
            WHERE proposal_id = ${proposalId} AND status = 'offered'`
            if (row.place === "home") yield* openHeldOnHome(sql, now)
            const proposal = yield* read(proposalId).pipe(Effect.flatMap(project))
            yield* changed(row)
            return { proposal, task: null }
          }
          if (row.place === "chat")
            return yield* failure("invalid", "A chat's suggestions cannot be started yet")
          const task =
            row.space_id === null
              ? yield* startFromHome(row, input.space_id, now)
              : yield* startOnSpace(row, row.space_id, input.space_id, authority)
          if (input.session_id !== undefined && (yield* isOrdinaryChat(sql, input.session_id)))
            yield* sql`UPDATE space_tasks SET home_session_id = ${input.session_id}
              WHERE item_id = ${task.item_id} AND space_id IS NOT NULL`
          yield* sql`UPDATE task_proposals SET
          status = 'accepted', item_id = ${task.item_id},
          settlement_client_id = ${input.client_id}, settlement_decision = 'accept',
          settlement_task_json = ${JSON.stringify(task)},
          updated_at = ${now}, settled_at = ${now}
          WHERE proposal_id = ${proposalId} AND status = 'offered'`
          if (row.place === "home") yield* openHeldOnHome(sql, now)
          const proposal = yield* read(proposalId).pipe(Effect.flatMap(project))
          yield* changed(row)
          return { proposal, task }
        })
      )
    },
    Effect.mapError((cause) =>
      cause instanceof TaskProposalStoreError || cause instanceof TaskProposalConflictError
        ? cause
        : failure("storage", "Could not resolve Task proposal", cause)
    )
  )

  const retire: TaskProposalStore["Service"]["retire"] = Effect.fn("TaskProposal.retire")(
    function* (input) {
      return yield* writer.transact(
        Effect.gen(function* () {
          yield* retireProposal(sql, input)
          const row = yield* read(input.proposalId)
          const proposal = yield* project(row)
          yield* changed(row)
          return proposal
        })
      )
    },
    Effect.mapError((cause) =>
      cause instanceof TaskProposalStoreError
        ? cause
        : failure("conflict", "Could not retire proposal", cause)
    )
  )
  return {
    list,
    get,
    propose,
    revise,
    suggestFromItem,
    resolve,
    retire,
    history: (input) =>
      writer
        .snapshot(readRecordedHistory(options.reader, "proposal", input))
        .pipe(
          Effect.mapError((cause) =>
            failure(
              cause._tag === "RecordedHistoryError" ? cause.reason : "storage",
              cause.message,
              cause
            )
          )
        )
  }
}
