import type { ResolveRunQuestionInput } from "@arden-hq/protocol/runs"
import { DateTime, Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  CONTRACT_LINE_LIMIT,
  CRITERION_EVIDENCE_LIMIT,
  ContractChangeSchema,
  CriterionEvidenceSchema,
  evidenceWords,
  type ContractChange,
  type ContractLine,
  type ContractLineInput,
  type ContractProposalRecord,
  type CriterionEvidence,
  type TaskContract
} from "../work/contract.js"
import { WorkStoreError, type WorkStore } from "../work/store.js"
import { resolveEvidence } from "./criterion-evidence.js"
import type { Writer } from "./deps.js"
import { ownMessageThisTurn } from "./permission-offers.js"
import { workError } from "./work-records.js"
import { taskUnfinishedSql } from "./task-status-sql.js"

const fail = (message: string) => (cause: unknown) => workError("storage", message, cause)

interface LineRow {
  readonly line_id: number
  readonly kind: "rule" | "criterion" | "decision"
  readonly text: string
  readonly rejected: string | null
  readonly source_message_id: string
  readonly evidence_json: string | null
}

const decodeChange = Schema.decodeUnknownOption(Schema.fromJsonString(ContractChangeSchema))
const decodeEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(CriterionEvidenceSchema))
)

const evidenceOf = (json: string | null): ReadonlyArray<CriterionEvidence> =>
  json === null ? [] : (Option.getOrUndefined(decodeEvidence(json)) ?? [])

export const readTaskContract = Effect.fn("TaskContract.read")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  const lines = yield* sql<LineRow>`SELECT line_id, kind, text, rejected, source_message_id,
      evidence_json
    FROM task_contract_lines WHERE item_id = ${itemId} AND retired_at IS NULL ORDER BY line_id`
  const pending = yield* sql<{ readonly question_id: string; readonly change_json: string }>`
    SELECT proposal.question_id, proposal.change_json FROM task_contract_proposals AS proposal
    JOIN run_questions AS question ON question.question_id = proposal.question_id
    WHERE proposal.item_id = ${itemId} AND proposal.decision IS NULL
      AND question.resolution IS NULL AND question.closed_at IS NULL
    ORDER BY proposal.created_at, proposal.question_id`
  return {
    lines: lines.map((row): ContractLine => {
      const base = { lineId: row.line_id, text: row.text, sourceMessageId: row.source_message_id }
      switch (row.kind) {
        case "rule":
          return { ...base, kind: "rule" }
        case "criterion":
          return { ...base, kind: "criterion", evidence: evidenceOf(row.evidence_json) }
        case "decision":
          return { ...base, kind: "decision", rejected: row.rejected ?? undefined }
      }
    }),
    pending: pending.flatMap((row) => {
      const change = Option.getOrUndefined(decodeChange(row.change_json))
      return change === undefined ? [] : [{ questionId: row.question_id, change }]
    })
  } satisfies TaskContract
})

export const unmetCriteria = (sql: SqlClient.SqlClient, itemId: string) =>
  sql<{ readonly line_id: number; readonly text: string }>`SELECT line_id, text
    FROM task_contract_lines
    WHERE item_id = ${itemId} AND kind = 'criterion' AND retired_at IS NULL
      AND evidence_json IS NULL
    ORDER BY line_id`

export const metCriteriaWords = Effect.fn("TaskContract.metWords")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  const rows = yield* sql<{
    readonly line_id: number
    readonly text: string
    readonly evidence_json: string
  }>`SELECT line_id, text, evidence_json FROM task_contract_lines
    WHERE item_id = ${itemId} AND kind = 'criterion' AND retired_at IS NULL
      AND evidence_json IS NOT NULL
    ORDER BY line_id`
  return rows.map(
    (row) =>
      `L${row.line_id} ${JSON.stringify(row.text)}: ${evidenceOf(row.evidence_json)
        .map((entry) => evidenceWords(entry.evidence))
        .join("; ")}`
  )
})

const liveLine = Effect.fn("TaskContract.liveLine")(function* (
  sql: SqlClient.SqlClient,
  itemId: string,
  lineId: number
) {
  const rows = yield* sql<{
    readonly kind: LineRow["kind"]
    readonly evidence_json: string | null
    readonly created_at: string
    readonly retired_at: string | null
  }>`SELECT kind, evidence_json, created_at, retired_at FROM task_contract_lines
    WHERE line_id = ${lineId} AND item_id = ${itemId}`.pipe(
    Effect.mapError(fail("Could not read the contract line"))
  )
  const line = rows[0]
  if (line === undefined)
    return yield* workError("not_found", `L${lineId} is not a line of this Task's contract`)
  if (line.retired_at !== null)
    return yield* workError("invalid", `L${lineId} was removed by the owner`)
  return line
})

export const recordContractProposalInTransaction = Effect.fn("TaskContract.recordProposal")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly questionId: string
    readonly runId: string
    readonly proposal: ContractProposalRecord
    readonly now: string
  }) {
    const { sql, proposal } = options
    const messageId = yield* ownMessageThisTurn(sql, options.runId)
    if (messageId === undefined)
      return yield* workError(
        "invalid",
        "A contract line is proposed only from the owner's own message in this turn"
      )
    const tasks = yield* sql<{ readonly lines: number }>`SELECT (SELECT COUNT(*)
        FROM task_contract_lines WHERE item_id = task.item_id AND retired_at IS NULL) AS lines
      FROM space_tasks AS task WHERE task.item_id = ${proposal.itemId} AND ${taskUnfinishedSql("task")}`.pipe(
      Effect.mapError(fail("Could not read the Task"))
    )
    const task = tasks[0]
    if (task === undefined) return yield* workError("not_found", "The Task is not live")
    const named = targetOf(proposal.change)
    if (named !== undefined) yield* liveLine(sql, proposal.itemId, named)
    if (named === undefined && task.lines >= CONTRACT_LINE_LIMIT)
      return yield* workError(
        "invalid",
        `The Task's contract holds ${CONTRACT_LINE_LIMIT} lines. Propose one that replaces a line, or ask the owner which line to remove.`
      )
    yield* sql`INSERT INTO task_contract_proposals (
        question_id, item_id, change_json, source_message_id, decision, created_at
      ) VALUES (
        ${options.questionId}, ${proposal.itemId}, ${JSON.stringify(proposal.change)},
        ${messageId}, NULL, ${options.now}
      )`.pipe(Effect.mapError(fail("Could not record the proposal")))
  }
)

const targetOf = (change: ContractChange): number | undefined =>
  change.kind === "add" ? change.replaces : change.line_id

export const isContractProposal = (sql: SqlClient.SqlClient, questionId: string) =>
  sql`SELECT 1 FROM task_contract_proposals WHERE question_id = ${questionId}`.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.mapError(fail("Could not read the proposal"))
  )

export const contractAnswerMisfit = (
  answer: ResolveRunQuestionInput["answer"]
): string | undefined =>
  answer.kind === "choice" || answer.kind === "dismiss" || answer.kind === "text"
    ? undefined
    : "A contract line takes Save, a reply or Skip."

export const settleContractProposalInTransaction = Effect.fn("TaskContract.settle")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly questionId: string
    readonly answer: ResolveRunQuestionInput["answer"]
    readonly now: string
  }) {
    const { sql, questionId, answer, now } = options
    const rows = yield* sql<{
      readonly item_id: string
      readonly change_json: string
      readonly source_message_id: string
    }>`SELECT item_id, change_json, source_message_id FROM task_contract_proposals
      WHERE question_id = ${questionId} AND decision IS NULL`.pipe(
      Effect.mapError(fail("Could not read the proposal"))
    )
    const proposal = rows[0]
    if (proposal === undefined) return
    const change = Option.getOrUndefined(decodeChange(proposal.change_json))
    if (change === undefined) return yield* workError("storage", "Stored proposal is corrupt")
    const confirmed = answer.kind === "choice"
    if (confirmed) {
      const target = targetOf(change)
      if (target !== undefined)
        yield* sql`UPDATE task_contract_lines SET retired_at = ${now}
          WHERE line_id = ${target} AND item_id = ${proposal.item_id} AND retired_at IS NULL`.pipe(
          Effect.mapError(fail("Could not retire the contract line"))
        )
      if (change.kind === "add") yield* saveLine(sql, proposal, change.line, now)
    }
    yield* sql`UPDATE task_contract_proposals
      SET decision = ${confirmed ? "confirmed" : "dismissed"}
      WHERE question_id = ${questionId}`.pipe(
      Effect.mapError(fail("Could not settle the proposal"))
    )
  }
)

const saveLine = (
  sql: SqlClient.SqlClient,
  proposal: { readonly item_id: string; readonly source_message_id: string },
  line: ContractLineInput,
  now: string
) =>
  sql`INSERT INTO task_contract_lines (
      item_id, kind, text, rejected, source_message_id, evidence_json, created_at, retired_at
    ) VALUES (
      ${proposal.item_id}, ${line.kind}, ${line.text},
      ${line.kind === "decision" ? (line.rejected ?? null) : null},
      ${proposal.source_message_id}, NULL, ${now}, NULL
    )`.pipe(Effect.mapError(fail("Could not save the contract line")))

export const makeTaskContractSql = (options: {
  readonly writer: Writer
}): Pick<WorkStore["Service"], "meetCriterion"> => {
  const { writer } = options
  const sql = writer.sql
  return {
    meetCriterion: (input) =>
      writer
        .transact(
          Effect.gen(function* () {
            const line = yield* liveLine(sql, input.itemId, input.lineId)
            if (line.kind !== "criterion")
              return yield* workError(
                "invalid",
                `L${input.lineId} is a ${line.kind}, not a done-when criterion`
              )
            const evidence = yield* resolveEvidence({
              sql,
              itemId: input.itemId,
              evidence: input.evidence,
              after: line.created_at
            })
            const now = DateTime.formatIso(yield* DateTime.now)
            const recorded = evidenceOf(line.evidence_json)
            const again = recorded.some(
              (entry) => JSON.stringify(entry.evidence) === JSON.stringify(evidence)
            )
            if (!again) {
              const kept = [...recorded, { evidence, recorded_at: now }].slice(
                -CRITERION_EVIDENCE_LIMIT
              )
              yield* sql`UPDATE task_contract_lines SET evidence_json = ${JSON.stringify(kept)}
                WHERE line_id = ${input.lineId}`
            }
            const unmet = yield* unmetCriteria(sql, input.itemId)
            return { lineId: input.lineId, evidence, unmet: unmet.length }
          })
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof WorkStoreError
              ? cause
              : workError("storage", "Could not record the evidence", cause)
          )
        )
  }
}
