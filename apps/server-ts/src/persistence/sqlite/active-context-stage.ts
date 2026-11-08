import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import type { UnitOfWork } from "../unit-of-work.js"
import type { Writer } from "./deps.js"
import { ActiveContextError, loadActiveContext } from "./active-context.js"

const STAGE_ROWS = 200

interface SourceRow {
  readonly context_from_seq: number | null
  readonly context_generation: number
  readonly legacy_context_revision: number
  readonly active_message_count: number
}

export interface StagePlan {
  readonly sessionId: string
  readonly generation: number
  readonly sourceRevision: number
  readonly sourceCount: number
  readonly from: number
  readonly head: number | null
  readonly count: number
  readonly newest: number
  readonly visible: ReadonlySet<number>
}

interface StageRow {
  readonly source_revision: number
  readonly context_generation: number
  readonly source_count: number
  readonly from_seq: number
  readonly head_seq: number | null
  readonly active_count: number
  readonly newest_seq: number
  readonly last_seq: number
}

export const planActiveContext = Effect.fn("ActiveContext.planStage")(function* (
  reader: SqlClient.SqlClient,
  sessionId: string
): Effect.fn.Return<StagePlan | null, ActiveContextError | SqlError.SqlError> {
  const source = (yield* reader<SourceRow>`
    SELECT context_from_seq, context_generation, legacy_context_revision, active_message_count
    FROM sessions WHERE session_id = ${sessionId}
  `)[0]
  if (source === undefined || source.context_from_seq !== null) return null
  yield* loadActiveContext(reader, sessionId)
  const named = yield* reader<{ readonly seq: number }>`
    SELECT m.seq FROM sessions AS s
      CROSS JOIN json_each(s.messages) AS j
      CROSS JOIN session_messages AS m
    WHERE s.session_id = ${sessionId}
      AND m.session_id = s.session_id
      AND m.message_id = j.value ->> '$.message_id'
    ORDER BY j.key
  `
  const seqs = named.map((entry) => entry.seq)
  const first = seqs[0]
  const head = first !== undefined && first > (seqs[1] ?? first) ? first : null
  const listed = [...new Set(head === null ? seqs : seqs.slice(1))].sort((a, b) => a - b)
  const newest =
    (yield* reader<{ readonly seq: number | null }>`
    SELECT MAX(seq) AS seq FROM session_messages WHERE session_id = ${sessionId}
  `)[0]?.seq ?? -1
  return {
    sessionId,
    generation: source.context_generation,
    sourceRevision: source.legacy_context_revision,
    sourceCount: source.active_message_count,
    from: listed[0] ?? (head === null ? newest + 1 : head + 1),
    head,
    count: listed.length + (head === null ? 0 : 1),
    newest,
    visible: new Set(head === null ? listed : [head, ...listed])
  }
})

const samePlan = (row: StageRow, plan: StagePlan): boolean =>
  row.source_revision === plan.sourceRevision &&
  row.context_generation === plan.generation &&
  row.source_count === plan.sourceCount &&
  row.from_seq === plan.from &&
  row.head_seq === plan.head &&
  row.active_count === plan.count &&
  row.newest_seq === plan.newest

export const stageActiveContextChunk = Effect.fn("ActiveContext.stageChunk")(function* (
  sql: SqlClient.SqlClient,
  plan: StagePlan,
  limit = STAGE_ROWS
): Effect.fn.Return<
  { readonly converted: boolean; readonly lastSeq: number },
  ActiveContextError | SqlError.SqlError
> {
  const state = (yield* sql<{
    readonly context_from_seq: number | null
    readonly context_generation: number
    readonly legacy_context_revision: number
    readonly active_message_count: number
  }>`
    SELECT context_from_seq, context_generation, legacy_context_revision, active_message_count
    FROM sessions WHERE session_id = ${plan.sessionId}
  `)[0]
  if (state === undefined || state.context_from_seq !== null)
    return { converted: true, lastSeq: plan.newest }
  let stage = (yield* sql<StageRow>`
    SELECT source_revision, context_generation, source_count, from_seq, head_seq,
      active_count, newest_seq, last_seq
    FROM session_context_stage WHERE session_id = ${plan.sessionId}
  `)[0]
  const latest =
    (yield* sql<{ readonly seq: number | null }>`
    SELECT MAX(seq) AS seq FROM session_messages WHERE session_id = ${plan.sessionId}
  `)[0]?.seq ?? -1
  if (
    state.context_generation !== plan.generation ||
    state.legacy_context_revision !== plan.sourceRevision ||
    state.active_message_count !== plan.sourceCount ||
    latest !== plan.newest ||
    (stage !== undefined && !samePlan(stage, plan))
  ) {
    if (stage === undefined) return { converted: false, lastSeq: -1 }
    if (
      stage.source_revision === state.legacy_context_revision &&
      stage.context_generation === state.context_generation &&
      stage.source_count === state.active_message_count &&
      stage.newest_seq === latest
    )
      return { converted: false, lastSeq: -1 }
    const hidden = yield* sql<{ readonly seq: number }>`
      SELECT seq FROM session_context_hidden
      WHERE session_id = ${plan.sessionId} AND seq >= ${stage.from_seq}
        AND seq <= ${stage.last_seq}
      ORDER BY seq LIMIT ${Math.min(limit, STAGE_ROWS)}
    `
    if (hidden.length > 0) {
      yield* sql`DELETE FROM session_context_hidden
        WHERE session_id = ${plan.sessionId} AND seq IN ${sql.in(hidden.map((row) => row.seq))}`
    }
    if (hidden.length === Math.min(limit, STAGE_ROWS)) return { converted: false, lastSeq: -2 }
    yield* sql`DELETE FROM session_context_stage WHERE session_id = ${plan.sessionId}`
    return { converted: false, lastSeq: -1 }
  }
  if (stage === undefined) {
    yield* sql`
      INSERT INTO session_context_stage (
        session_id, source_revision, context_generation, source_count, from_seq,
        head_seq, active_count, newest_seq, last_seq
      ) VALUES (
        ${plan.sessionId}, ${plan.sourceRevision}, ${plan.generation}, ${plan.sourceCount}, ${plan.from},
        ${plan.head}, ${plan.count}, ${plan.newest}, ${plan.from - 1}
      )
    `
    stage = {
      source_revision: plan.sourceRevision,
      context_generation: plan.generation,
      source_count: plan.sourceCount,
      from_seq: plan.from,
      head_seq: plan.head,
      active_count: plan.count,
      newest_seq: plan.newest,
      last_seq: plan.from - 1
    }
  }
  const rows = yield* sql<{ readonly seq: number }>`
    SELECT seq FROM session_messages
    WHERE session_id = ${plan.sessionId} AND seq > ${stage.last_seq}
    ORDER BY seq LIMIT ${Math.min(limit, STAGE_ROWS)}
  `
  const hidden = rows
    .map((row) => row.seq)
    .filter((seq) => seq >= plan.from && !plan.visible.has(seq))
  if (hidden.length > 0) {
    yield* sql`
      INSERT OR IGNORE INTO session_context_hidden (session_id, seq)
      SELECT ${plan.sessionId}, seq FROM session_messages
      WHERE session_id = ${plan.sessionId} AND seq IN ${sql.in(hidden)}
    `
  }
  const lastSeq = rows.at(-1)?.seq ?? stage.last_seq
  if (lastSeq < plan.newest) {
    yield* sql`UPDATE session_context_stage SET last_seq = ${lastSeq}
      WHERE session_id = ${plan.sessionId}`
    return { converted: false, lastSeq }
  }
  yield* sql`
    UPDATE sessions SET context_from_seq = ${plan.from}, context_head_seq = ${plan.head},
      messages = NULL, active_message_count = ${plan.count}
    WHERE session_id = ${plan.sessionId} AND context_from_seq IS NULL
      AND context_generation = ${plan.generation}
      AND legacy_context_revision = ${plan.sourceRevision}
      AND active_message_count = ${plan.sourceCount}
  `
  yield* sql`DELETE FROM session_context_stage WHERE session_id = ${plan.sessionId}`
  return { converted: true, lastSeq }
})

const ensureActiveContextWindow = Effect.fn("ActiveContext.ensureWindow")(function* (
  writer: Writer,
  sessionId: string,
  lane: "ordinary" | "interactive" = "interactive"
): Effect.fn.Return<void, ActiveContextError | SqlError.SqlError> {
  const transact = lane === "interactive" ? writer.transactInteractive : writer.transact
  for (;;) {
    const plan = yield* writer.snapshot(planActiveContext(writer.reader, sessionId))
    if (plan === null) return
    for (;;) {
      const step = yield* transact(stageActiveContextChunk(writer.sql, plan))
      if (step.converted) return
      if (step.lastSeq === -1) break
    }
  }
})

export type ActiveContextIdentity =
  | { readonly sessionId: string }
  | { readonly runId: string }
  | {
      readonly lookup: (
        sql: SqlClient.SqlClient
      ) => Effect.Effect<string | undefined, SqlError.SqlError>
    }

export const transactWithActiveContext = Effect.fn("ActiveContext.transact")(function* <A, E>(
  writer: Writer,
  lane: "ordinary" | "interactive",
  identity: ActiveContextIdentity,
  work: Effect.Effect<A, E, UnitOfWork>
): Effect.fn.Return<A, E | ActiveContextError | SqlError.SqlError> {
  const sql = writer.sql
  const transact = lane === "interactive" ? writer.transactInteractive : writer.transact
  for (;;) {
    const attempt = yield* transact(
      Effect.gen(function* () {
        let sessionId: string | undefined
        if ("sessionId" in identity) sessionId = identity.sessionId
        else if ("runId" in identity) {
          sessionId = (yield* sql<{ readonly session_id: string }>`
            SELECT session_id FROM chat_runs WHERE run_id = ${identity.runId}
          `)[0]?.session_id
        } else sessionId = yield* identity.lookup(sql)
        if (sessionId !== undefined) {
          const row = (yield* sql<{ readonly context_from_seq: number | null }>`
            SELECT context_from_seq FROM sessions WHERE session_id = ${sessionId}
          `)[0]
          if (row?.context_from_seq === null) return { kind: "prepare" as const, sessionId }
        }
        return { kind: "done" as const, value: yield* work }
      })
    )
    if (attempt.kind === "done") return attempt.value
    yield* ensureActiveContextWindow(writer, attempt.sessionId, lane)
  }
})
