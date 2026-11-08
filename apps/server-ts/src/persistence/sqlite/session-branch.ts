import { DateTime, Effect, Schema } from "effect"
import { withoutTurnStamp } from "../transcript/model.js"
import {
  SessionStoreError,
  type BranchedSession,
  type BranchOptions,
  type SessionStore
} from "../sessions/store.js"
import { JsonObjectSchema } from "../json.js"
import { decodeJson, encodeJson } from "./json.js"
import { rebuildSessionTurns } from "./turns.js"
import { friendlySessionRef } from "../public-ref.js"
import { nextId } from "./deps.js"
import { insertSession } from "./session-insert.js"
import { loadActiveContext, replaceActiveContext } from "./active-context.js"
import {
  makeSessionForkOrigin,
  prepareForkContext,
  sessionForkOriginMetadata
} from "./session-fork.js"
import { appendMessagesInTransaction } from "./chat-transcript.js"
import { sessionBlockingWorkPredicate } from "./session-blocking-work.js"
import type { PersistenceDeps } from "./deps.js"
import {
  type BranchMessageRow,
  OptionalInputTokens,
  messageListEquivalent,
  storeError,
  sessionIdSchema,
  sessionNameSchema,
  decodeTranscriptRow
} from "./session-rows.js"
import { openDeferredCallStatusList } from "./status-sets.js"
import { sessionDescendants } from "./tree-walk.js"

const BranchOptionsSchema = Schema.Struct({
  disposition: Schema.optionalKey(Schema.UndefinedOr(Schema.Literals(["retained", "disposable"]))),
  name: Schema.optionalKey(Schema.UndefinedOr(sessionNameSchema)),
  upToMessageId: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  requestId: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  shareResources: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean))
})

const branchRequest = (input: BranchOptions, sourceSessionId: string): string =>
  JSON.stringify({
    sourceSessionId,
    name: input.name ?? null,
    upToMessageId: input.upToMessageId ?? null,
    shareResources: input.shareResources === true,
    disposition: input.disposition ?? "retained"
  })

interface BranchSourceRow {
  readonly public_ref: string
  readonly name: string | null
  readonly space_id: string | null
  readonly metadata: string | null
  readonly source_policy_generation: number
}
export const makeSessionBranch = ({
  writer
}: Pick<PersistenceDeps, "writer">): Pick<
  SessionStore["Service"],
  "branch" | "completeBranchPreparation" | "preparingForks"
> => {
  const sql = writer.sql
  const loadBranchedSession = Effect.fn("SessionBranch.loadPrepared")(function* (
    sessionId: string
  ) {
    const rows = yield* sql<{
      readonly session_id: string
      readonly name: string | null
      readonly started_at: string
      readonly last_activity: string
      readonly space_id: string | null
      readonly source_session_id: string
      readonly source_session_ref: string
      readonly through_sequence: number
      readonly source_message_id: string | null
      readonly created_at: string
    }>`SELECT s.session_id, s.name, s.started_at, s.last_activity, s.space_id,
                 json_extract(s.metadata, '$.fork_origin.sourceSessionId') AS source_session_id,
                 json_extract(s.metadata, '$.fork_origin.sourceSessionRef') AS source_session_ref,
                 json_extract(s.metadata, '$.fork_origin.throughSequence') AS through_sequence,
                 json_extract(s.metadata, '$.fork_origin.sourceMessageId') AS source_message_id,
                 json_extract(s.metadata, '$.fork_origin.createdAt') AS created_at
          FROM sessions AS s WHERE s.session_id = ${sessionId}`
    const row = rows[0]
    if (row === undefined) return undefined
    const forkOrigin = yield* makeSessionForkOrigin({
      sourceSessionId: row.source_session_id,
      sourceSessionRef: row.source_session_ref,
      throughSequence: row.through_sequence,
      sourceMessageId: row.source_message_id,
      createdAt: row.created_at
    })
    return {
      sessionId: row.session_id,
      name: row.name ?? undefined,
      startedAt: row.started_at,
      lastActivity: row.last_activity,
      spaceId: row.space_id ?? undefined,
      forkOrigin
    }
  })
  const branch = Effect.fn("SqliteSessionStore.branch")(function* (
    sessionId: string,
    options: BranchOptions
  ): Effect.fn.Return<BranchedSession | undefined, SessionStoreError> {
    const validSessionId = yield* Schema.decodeUnknownEffect(sessionIdSchema)(sessionId).pipe(
      Effect.mapError((cause) =>
        storeError("branch", "invalid", "Session id must not be empty", sessionId, cause)
      )
    )
    const valid = yield* Schema.decodeUnknownEffect(BranchOptionsSchema)(options, {
      onExcessProperty: "error"
    }).pipe(
      Effect.mapError((cause) =>
        storeError("branch", "invalid", "Invalid branch request", validSessionId, cause)
      )
    )
    const branchId = yield* nextId
    const requestId = valid.requestId ?? `fork:${branchId}`
    const requestJson = branchRequest(valid, validSessionId)
    const now = yield* DateTime.now
    const timestamp = DateTime.formatIso(now)

    return yield* writer
      .transact(
        Effect.gen(function* () {
          const previous = yield* sql<{
            readonly source_session_id: string
            readonly request_json: string
            readonly child_session_id: string
          }>`
            SELECT source_session_id, request_json, child_session_id
            FROM session_fork_requests WHERE request_id = ${requestId}
          `
          if (previous[0] !== undefined) {
            const adopting =
              valid.disposition === "disposable" &&
              previous[0].request_json ===
                branchRequest({ ...valid, disposition: "retained" }, validSessionId)
            if (
              previous[0].source_session_id !== validSessionId ||
              (previous[0].request_json !== requestJson && !adopting)
            ) {
              return yield* storeError(
                "branch",
                "conflict",
                "This branch was already requested with different settings. Start it again.",
                validSessionId
              )
            }
            if (adopting) {
              const busy = yield* sql`WITH RECURSIVE ${sessionDescendants(sql, {
                name: "owned",
                from: sql`SELECT ${previous[0].child_session_id} AS session_id`,
                where: sql`child.session_type = 'agent'`
              })}
              SELECT 1 FROM owned JOIN sessions AS s ON s.session_id = owned.session_id
              WHERE ${sessionBlockingWorkPredicate(sql)}
                OR EXISTS (SELECT 1 FROM session_queued_messages AS queued
                  WHERE queued.session_id = s.session_id)
                OR EXISTS (SELECT 1 FROM tool_approvals AS approval
                  WHERE approval.session_id = s.session_id AND approval.status = 'pending')
                OR EXISTS (SELECT 1 FROM deferred_tool_calls AS deferred
                  WHERE deferred.session_id = s.session_id
                    AND deferred.status IN ${openDeferredCallStatusList})
                OR EXISTS (SELECT 1 FROM tool_calls AS tool_call
                  WHERE tool_call.session_id = s.session_id
                    AND tool_call.status = 'uncertain' AND tool_call.changes_state = 1)
              LIMIT 1`
              if (busy.length > 0) {
                return yield* storeError(
                  "branch",
                  "conflict",
                  "This branch still has work running. Let it finish first.",
                  previous[0].child_session_id
                )
              }
              const adopted = yield* sql`UPDATE sessions SET parent_session_id = ${validSessionId}
                WHERE session_id = ${previous[0].child_session_id} AND session_type = 'chat'
                  AND parent_session_id IS NULL AND parent_message_id IS NULL
                  AND archived_at IS NULL RETURNING session_id`
              if (adopted.length === 0) {
                return yield* storeError(
                  "branch",
                  "conflict",
                  "This branch cannot be marked as throwaway.",
                  validSessionId
                )
              }
              yield* sql`UPDATE session_fork_requests SET request_json = ${requestJson}
                WHERE request_id = ${requestId}`
            }
            return yield* loadBranchedSession(previous[0].child_session_id)
          }

          const sources = yield* sql<BranchSourceRow>`
        SELECT source.public_ref, source.name, source.space_id, source.metadata,
          COALESCE(json_extract(authority.metadata, '$.policy_generation'), 0) AS source_policy_generation
        FROM sessions AS source
        LEFT JOIN chat_runs AS latest_policy ON latest_policy.run_id = (
          SELECT run.run_id FROM chat_runs AS run
          WHERE run.session_id = source.session_id
            AND json_type(run.metadata_json, '$.run_policy') = 'object'
          ORDER BY run.started_at DESC, run.run_id DESC LIMIT 1
        )
        LEFT JOIN sessions AS authority ON authority.session_id = COALESCE(
          json_extract(latest_policy.metadata_json, '$.run_policy.authority_session_id'), source.session_id
        )
        WHERE source.session_id = ${validSessionId} AND source.archived_at IS NULL
        LIMIT 1
      `.pipe(
            Effect.mapError((cause) =>
              storeError(
                "branch",
                "storage",
                "Could not load the source session",
                validSessionId,
                cause
              )
            )
          )
          const source = sources[0]
          if (source === undefined) return undefined

          const projection = yield* loadActiveContext(sql, validSessionId).pipe(
            Effect.mapError((cause) =>
              storeError(
                "branch",
                "storage",
                "Source session projection is corrupt",
                validSessionId,
                cause
              )
            )
          )

          const transcriptRows = yield* sql<BranchMessageRow>`
        SELECT seq, message_id, role, message_json, client_id, created_at
        FROM session_messages
        WHERE session_id = ${validSessionId}
        ORDER BY seq ASC
      `.pipe(
            Effect.mapError((cause) =>
              storeError(
                "branch",
                "storage",
                "Could not load the source transcript",
                validSessionId,
                cause
              )
            )
          )
          const transcript = yield* Effect.forEach(transcriptRows, (row) =>
            decodeTranscriptRow(row, {
              operation: "branch",
              sessionId: validSessionId,
              label: "Source transcript"
            })
          )
          const compacted = yield* sql<{ readonly found: number }>`
            SELECT EXISTS(SELECT 1 FROM chat_compactions WHERE session_id = ${validSessionId}) AS found
          `.pipe(
            Effect.mapError((cause) =>
              storeError(
                "branch",
                "storage",
                "Could not inspect source history",
                validSessionId,
                cause
              )
            )
          )
          if (valid.upToMessageId !== undefined) {
            const reconstructable =
              (compacted[0]?.found ?? 0) === 0 &&
              messageListEquivalent(
                projection.map(withoutTurnStamp),
                transcript.map(withoutTurnStamp)
              )
            if (!reconstructable) {
              return yield* storeError(
                "branch",
                "conflict",
                "This point in the chat cannot be branched from. Branch from a later message.",
                validSessionId
              )
            }
          }

          let end = projection.length
          if (valid.upToMessageId !== undefined) {
            const target = projection.findIndex(
              (message) =>
                message.message_id === valid.upToMessageId ||
                message.client_id === valid.upToMessageId
            )
            if (target < 0) return undefined
            end = target + 1
            while (end < projection.length && projection[end]?.role === "tool") end += 1
          }

          const selectedMessages = projection.slice(0, end)
          const lastSelected = selectedMessages.at(-1)
          const boundaryRow =
            valid.upToMessageId === undefined
              ? transcriptRows.at(-1)
              : transcriptRows.find(
                  (row) =>
                    lastSelected !== undefined &&
                    (row.message_id === lastSelected.message_id ||
                      row.client_id === lastSelected.client_id)
                )
          const sourceMetadata = yield* decodeJson(JsonObjectSchema, source.metadata ?? "{}").pipe(
            Effect.mapError((cause) =>
              storeError(
                "branch",
                "storage",
                "Source session metadata is corrupt",
                validSessionId,
                cause
              )
            )
          )
          const lastInputTokens = yield* Schema.decodeUnknownEffect(OptionalInputTokens)(
            sourceMetadata.last_input_tokens ?? null
          ).pipe(
            Effect.mapError((cause) =>
              storeError(
                "branch",
                "storage",
                "Source input-token metadata is corrupt",
                validSessionId,
                cause
              )
            )
          )
          const forkOrigin = yield* makeSessionForkOrigin({
            sourceSessionId: validSessionId,
            sourceSessionRef: source.public_ref,
            throughSequence: boundaryRow?.seq ?? -1,
            sourceMessageId: boundaryRow?.message_id ?? null,
            createdAt: timestamp
          }).pipe(
            Effect.mapError((cause) =>
              storeError("branch", "invalid", "Fork origin is invalid", branchId, cause)
            )
          )
          const metadataJson = yield* encodeJson(JsonObjectSchema, {
            fork_origin: sessionForkOriginMetadata(forkOrigin),
            ...(valid.shareResources === true
              ? {
                  fork_resources: {
                    version: 1,
                    source_session_id: validSessionId,
                    source_policy_generation: source.source_policy_generation
                  }
                }
              : {}),
            ...(end < projection.length || lastInputTokens === null || lastInputTokens === 0
              ? {}
              : { last_input_tokens: lastInputTokens }),
            ...(sourceMetadata.cli === undefined ? {} : { cli: sourceMetadata.cli })
          }).pipe(
            Effect.mapError((cause) =>
              storeError(
                "branch",
                "storage",
                "Could not encode branch metadata",
                validSessionId,
                cause
              )
            )
          )
          const name = valid.name ?? (source.name === null ? null : `${source.name} (branch)`)

          yield* insertSession({
            sql,
            session: {
              type: "chat",
              sessionId: branchId,
              publicRef: friendlySessionRef(branchId),
              startedAt: timestamp,
              name,
              metadata: metadataJson,
              spaceId: source.space_id,
              chatModel: null,
              originAutomationId: null,
              parent:
                valid.disposition === "disposable"
                  ? { sessionId: validSessionId, messageId: null }
                  : null
            },
            lifecycle: { kind: "silent", reason: "branch" }
          }).pipe(
            Effect.mapError((cause) =>
              storeError("branch", "storage", "Could not create branch session", branchId, cause)
            )
          )
          yield* sql`
        INSERT INTO session_messages (
          session_id, message_id, seq, role, message_json, client_id,
          created_at, search_text
        )
        SELECT ${branchId}, message_id, ROW_NUMBER() OVER (ORDER BY seq) - 1,
               role, message_json, client_id, created_at, search_text
        FROM session_messages
        WHERE session_id = ${validSessionId} AND seq <= ${boundaryRow?.seq ?? -1}
        ORDER BY seq ASC
      `.pipe(
            Effect.mapError((cause) =>
              storeError("branch", "storage", "Could not copy branch transcript", branchId, cause)
            )
          )
          yield* sql`INSERT INTO chat_event_deliveries
            (session_id, event_key, message_id, delivered_at)
            SELECT ${branchId}, delivery.event_key, delivery.message_id, delivery.delivered_at
            FROM chat_event_deliveries AS delivery
            WHERE delivery.session_id = ${validSessionId} AND EXISTS (
              SELECT 1 FROM session_messages AS copied
              WHERE copied.session_id = ${branchId} AND copied.message_id = delivery.message_id
            )`
          yield* sql`
        INSERT INTO answer_block_state (session_id, message_id, block_index, state_json, updated_at)
        SELECT ${branchId}, saved.message_id, saved.block_index, saved.state_json, saved.updated_at
        FROM answer_block_state AS saved
        WHERE saved.session_id = ${validSessionId}
          AND EXISTS (
            SELECT 1 FROM session_messages
            WHERE session_id = ${branchId} AND message_id = saved.message_id
          )
      `.pipe(
            Effect.mapError((cause) =>
              storeError("branch", "storage", "Could not copy answer block values", branchId, cause)
            )
          )
          const normalizedContext = yield* prepareForkContext({
            history: selectedMessages,
            parentSessionId: validSessionId,
            forkId: branchId,
            closeOpenCall: () =>
              "This call belongs to the source chat; its result is not available here.",
            timestamp,
            operation: "fork_session",
            presentation: "preserve"
          }).pipe(
            Effect.mapError((cause) =>
              storeError(
                "branch",
                "invalid",
                "This chat cannot be branched from here.",
                validSessionId,
                cause
              )
            )
          )
          const originalContextIds = new Set(selectedMessages.map((message) => message.message_id))
          const closingMessages = normalizedContext.filter(
            (message) => !originalContextIds.has(message.message_id)
          )
          if (closingMessages.length > 0) {
            yield* appendMessagesInTransaction(
              sql,
              branchId,
              closingMessages,
              timestamp,
              "fork_session",
              `fork:${branchId}`
            ).pipe(
              Effect.mapError((cause) =>
                storeError(
                  "branch",
                  "storage",
                  "Could not close source tool calls",
                  branchId,
                  cause
                )
              )
            )
          }
          yield* replaceActiveContext(sql, branchId, normalizedContext).pipe(
            Effect.mapError((cause) =>
              storeError("branch", "storage", "Could not set the branch context", branchId, cause)
            )
          )
          yield* rebuildSessionTurns(sql, branchId).pipe(
            Effect.mapError((cause) =>
              storeError("branch", "storage", "Could not rebuild branch turns", branchId, cause)
            )
          )

          yield* sql`
            INSERT INTO session_fork_requests
              (request_id, source_session_id, request_json, child_session_id, state)
            VALUES (${requestId}, ${validSessionId}, ${requestJson}, ${branchId}, 'preparing')
          `.pipe(
            Effect.mapError((cause) =>
              storeError("branch", "storage", "Could not record fork preparation", branchId, cause)
            )
          )

          return {
            sessionId: branchId,
            name: name ?? undefined,
            startedAt: timestamp,
            lastActivity: timestamp,
            spaceId: source.space_id ?? undefined,
            forkOrigin
          }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionStoreError
            ? cause
            : storeError(
                "branch",
                "storage",
                "Could not create session branch",
                validSessionId,
                cause
              )
        )
      )
  })

  const completeBranchPreparation = Effect.fn("SqliteSessionStore.completeBranchPreparation")(
    function* (input: { readonly childSessionId: string }) {
      const updated = yield* writer
        .transact(
          writer.sql`UPDATE session_fork_requests SET state = 'ready'
        WHERE child_session_id = ${input.childSessionId} AND state = 'preparing'
        RETURNING child_session_id`
        )
        .pipe(
          Effect.mapError((cause) =>
            storeError(
              "branch",
              "storage",
              "Could not complete fork preparation",
              input.childSessionId,
              cause
            )
          )
        )
      if (updated.length > 0) return true
      const existing = yield* writer.sql<{ readonly ready: number }>`SELECT state = 'ready' AS ready
        FROM session_fork_requests WHERE child_session_id = ${input.childSessionId}`.pipe(
        Effect.mapError((cause) =>
          storeError(
            "branch",
            "storage",
            "Could not inspect fork preparation",
            input.childSessionId,
            cause
          )
        )
      )
      return existing[0]?.ready === 1
    }
  )

  const preparingForks = Effect.fn("SqliteSessionStore.preparingForks")(function* (input?: {
    readonly childSessionId?: string
  }) {
    const childSessionId = input?.childSessionId ?? null
    const rows = yield* sql<{
      readonly child_session_id: string
      readonly source_session_id: string
      readonly owner_content: number
    }>`SELECT fork.child_session_id, fork.source_session_id, (
        EXISTS (SELECT 1 FROM chat_runs WHERE session_id = fork.child_session_id)
        OR EXISTS (SELECT 1 FROM session_queued_messages WHERE session_id = fork.child_session_id)
        OR EXISTS (
          SELECT 1 FROM session_revisions AS made
          JOIN session_revisions AS later
            ON later.session_id = made.session_id AND later.version > made.version
          WHERE made.session_id = fork.child_session_id AND made.kind = 'created'
            AND later.kind = 'changed'
            AND (json_extract(later.state_json, '$.name') IS NOT json_extract(made.state_json, '$.name')
              OR json_extract(later.state_json, '$.space_id') IS NOT json_extract(made.state_json, '$.space_id')
              OR json_extract(later.state_json, '$.archived_at') IS NOT json_extract(made.state_json, '$.archived_at'))
        )
        OR EXISTS (
          SELECT 1 FROM session_messages AS own
          WHERE own.session_id = fork.child_session_id AND own.role = 'user'
            AND NOT EXISTS (
              SELECT 1 FROM session_messages AS copied
              WHERE copied.session_id = fork.source_session_id AND copied.message_id = own.message_id
            )
        )
      ) AS owner_content
      FROM session_fork_requests AS fork
      WHERE fork.state = 'preparing'
        AND (${childSessionId} IS NULL OR fork.child_session_id = ${childSessionId})
      ORDER BY fork.child_session_id`.pipe(
      Effect.mapError((cause) =>
        storeError(
          "branch",
          "storage",
          "Could not list preparing forks",
          childSessionId ?? "",
          cause
        )
      )
    )
    return rows.map((row) => ({
      childSessionId: row.child_session_id,
      sourceSessionId: row.source_session_id,
      hasOwnerContent: row.owner_content === 1
    }))
  })

  return { branch, completeBranchPreparation, preparingForks }
}
