import { SOURCE_KIND } from "@arden-hq/protocol/spaces/work"
import { TaskSourceRecordSchema, type TaskRecord } from "../work/task-record.js"
import type { SqlClient } from "effect/unstable/sql"
import { SpaceTaskCaptureInputSchema } from "@arden-hq/protocol/effect/spaces/work"
import { Effect, Schema } from "effect"
import {
  type TaskProposalSettlementAuthority,
  type TaskProposalStoreError
} from "../proposals/store.js"
import { TaskProposalConflictError } from "../proposals/conflict.js"
import { decodeJson, type JsonColumnError } from "./json.js"
import { makeWorkCaptureSql } from "./work-capture.js"
import { userChatSql } from "./chat-ownership.js"
import { type ProposalRow, failure } from "./task-proposal-support.js"
import { type WorkStoreError } from "../work/store.js"
import { type SqlError } from "effect/unstable/sql/SqlError"
import { type UnitOfWork } from "../unit-of-work.js"

type ProposalStartError =
  | WorkStoreError
  | SqlError
  | TaskProposalStoreError
  | TaskProposalConflictError
  | JsonColumnError

export interface TaskProposalStart {
  readonly startOnSpace: (
    row: ProposalRow,
    spaceId: string,
    picked: string | undefined,
    authority: TaskProposalSettlementAuthority
  ) => Effect.Effect<TaskRecord, ProposalStartError, UnitOfWork>
  readonly authoredWithoutSpace: (row: ProposalRow) => Effect.Effect<boolean, SqlError>
  readonly startWithoutSpace: (
    row: ProposalRow,
    spaceId: string
  ) => Effect.Effect<TaskRecord, Exclude<ProposalStartError, TaskProposalStoreError>, UnitOfWork>
}

export const makeTaskProposalStart = ({
  sql,
  work
}: {
  readonly sql: SqlClient.SqlClient
  readonly work: ReturnType<typeof makeWorkCaptureSql>
}): TaskProposalStart => {
  const assertItemsStored = Effect.fn("TaskProposal.assertItemsStored")(function* (
    sources: ReadonlyArray<typeof TaskSourceRecordSchema.Type>
  ) {
    for (const source of sources) {
      if (source.kind !== SOURCE_KIND.connection_item) continue
      const stored = yield* sql`SELECT 1 FROM connection_items WHERE item_id = ${source.item_id}`
      if (stored.length === 0)
        return yield* new TaskProposalConflictError({
          kind: "source_unavailable",
          message: "That item expired"
        })
    }
  })

  const validateStoredSources = Effect.fn("TaskProposal.validateSources")(function* (
    spaceId: string,
    sources: ReadonlyArray<typeof TaskSourceRecordSchema.Type>,
    authority: TaskProposalSettlementAuthority
  ) {
    for (const source of sources) {
      if (source.kind === SOURCE_KIND.chat) {
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
      } else if (
        source.kind === SOURCE_KIND.memory &&
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
    const sources = yield* decodeJson(Schema.Array(TaskSourceRecordSchema), row.sources_json)
    yield* assertItemsStored(sources)
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

  const authoredWithoutSpace = (row: ProposalRow) =>
    sql`SELECT 1 FROM chat_runs WHERE run_id = ${row.source_run_id}
      AND json_extract(metadata_json, '$.run_policy.space.space_id') IS NULL`.pipe(
      Effect.map((rows) => rows.length > 0)
    )

  const startWithoutSpace = Effect.fn("TaskProposal.startWithoutSpace")(function* (
    row: ProposalRow,
    spaceId: string
  ) {
    const spaces =
      yield* sql`SELECT 1 FROM spaces WHERE space_id = ${spaceId} AND archived_at IS NULL`
    if (spaces.length === 0) {
      return yield* new TaskProposalConflictError({
        kind: "space_unavailable",
        message: "That Space is archived"
      })
    }
    const sources = yield* decodeJson(Schema.Array(TaskSourceRecordSchema), row.sources_json)
    yield* assertItemsStored(sources)
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
  return { startOnSpace, authoredWithoutSpace, startWithoutSpace }
}
