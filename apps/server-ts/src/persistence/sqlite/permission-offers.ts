import type { ResolveRunQuestionInput } from "@arden-hq/protocol/runs"
import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import {
  OfferChoiceSchema,
  PermissionChangeSchema,
  allowSubjects,
  changeJson,
  offerChoiceList,
  type OfferChoice,
  type PermissionChange,
  type PermissionOfferRecord
} from "../permissions/offer.js"
import {
  changeRuleInTransaction,
  saveAllowsInTransaction,
  saveRuleInTransaction,
  saveWordsInTransaction
} from "./permission-rules.js"
import { ruleOfSetting, type PermissionRulesError } from "../permissions/rules.js"
import { decodeJson } from "./json.js"
import { workError } from "./work-records.js"

const OfferChoicesSchema = Schema.Array(OfferChoiceSchema)

export const ownerWordsSql = (
  sql: SqlClient.SqlClient,
  message: Statement.Fragment
): Statement.Fragment => sql`${message}.role = 'user'
  AND (COALESCE(json_extract(${message}.message_json, '$.is_meta'), 0) = 0
    OR json_extract(${message}.message_json, '$.question_answer') IS NOT NULL)
  AND json_extract(${message}.message_json, '$.interaction') IS NULL
  AND json_extract(${message}.message_json, '$.from_chat') IS NULL
  AND json_extract(${message}.message_json, '$.sent_from') IS NULL`

const deliveredSql = (sql: SqlClient.SqlClient, message: Statement.Fragment): Statement.Fragment =>
  sql`(json_extract(${message}.message_json, '$.interaction') IS NOT NULL
    AND json_extract(${message}.message_json, '$.from_chat') IS NULL
    AND json_extract(${message}.message_json, '$.sent_from') IS NULL)`

export const ownMessageThisTurn = (sql: SqlClient.SqlClient, runId: string) =>
  Effect.gen(function* () {
    const inTurn = yield* sql<{ readonly message_id: string }>`
      SELECT message.message_id FROM chat_runs AS run
      JOIN session_messages AS turn ON turn.session_id = run.session_id
        AND turn.message_id = json_extract(run.metadata_json, '$.turn_id')
      JOIN session_messages AS message ON message.session_id = run.session_id
        AND message.seq >= turn.seq
      WHERE run.run_id = ${runId} AND ${ownerWordsSql(sql, sql`message`)}
      ORDER BY message.seq DESC LIMIT 1
    `
    if (inTurn[0] !== undefined) return inTurn[0].message_id
    const delivered = yield* sql<{ readonly message_id: string }>`
      SELECT message.message_id FROM chat_runs AS run
      JOIN session_messages AS turn ON turn.session_id = run.session_id
        AND turn.message_id = json_extract(run.metadata_json, '$.turn_id')
      JOIN session_messages AS message ON message.session_id = run.session_id
        AND message.seq < turn.seq
      WHERE run.run_id = ${runId}
        AND json_extract(run.metadata_json, '$.run_context.origin.kind') = 'chat'
        AND json_extract(run.metadata_json, '$.run_context.origin.session_id') = run.session_id
        AND ${deliveredSql(sql, sql`turn`)}
        AND ${ownerWordsSql(sql, sql`message`)}
        AND NOT EXISTS (
          SELECT 1 FROM session_messages AS between_
          WHERE between_.session_id = run.session_id AND between_.role = 'user'
            AND between_.seq > message.seq AND between_.seq <= turn.seq
            AND NOT ${deliveredSql(sql, sql`between_`)}
        )
      ORDER BY message.seq DESC LIMIT 1
    `
    return delivered[0]?.message_id
  }).pipe(
    Effect.mapError((cause) => workError("storage", "Could not read the person's message", cause))
  )

export const recordPermissionOfferInTransaction = Effect.fn("PermissionOffer.record")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly questionId: string
    readonly runId: string
    readonly offer: PermissionOfferRecord
    readonly now: string
  }) {
    const { sql, offer } = options
    const runs = yield* sql<{ readonly session_id: string }>`
      SELECT session_id FROM chat_runs WHERE run_id = ${options.runId}
    `.pipe(Effect.mapError((cause) => workError("storage", "Could not read the asking Run", cause)))
    const sessionId = runs[0]?.session_id
    if (sessionId === undefined) return yield* workError("not_found", "The asking Run is gone")
    const messageId =
      offer.source.kind === "message" ? yield* ownMessageThisTurn(sql, options.runId) : undefined
    if (offer.source.kind === "message" && messageId === undefined)
      return yield* workError(
        "invalid",
        "A permission is offered only after the person's own message in this turn"
      )
    const toolName =
      offer.change.kind === "tool" || offer.change.kind === "site" ? offer.change.tool : null
    yield* sql`INSERT INTO permission_offers (
        question_id, session_id, tool_name, server_name, change_json, source_kind,
        source_message_id, choices_json, decision, created_at, settled_at
      ) VALUES (
        ${options.questionId}, ${sessionId}, ${toolName}, ${offer.serverName},
        ${changeJson(offer.change)}, ${offer.source.kind}, ${messageId ?? null},
        ${JSON.stringify(offer.choices)}, NULL, ${options.now}, NULL
      )`.pipe(Effect.mapError((cause) => workError("storage", "Could not record the offer", cause)))
  }
)

export const offerAnswerMisfit = (answer: ResolveRunQuestionInput["answer"]): string | undefined =>
  answer.kind === "choice" || answer.kind === "dismiss"
    ? undefined
    : "A permission offer takes one of its choices, or Not now"

const fail = (message: string) => (cause: unknown) => workError("storage", message, cause)

export const settlePermissionOfferInTransaction = Effect.fn("PermissionOffer.settle")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly questionId: string
    readonly answer: ResolveRunQuestionInput["answer"]
    readonly now: string
  }) {
    const { sql, now } = options
    const rows = yield* sql<{
      readonly server_name: string | null
      readonly change_json: string
      readonly choices_json: string
    }>`SELECT offer.server_name, offer.change_json, offer.choices_json
      FROM permission_offers AS offer
      JOIN run_questions AS question ON question.question_id = offer.question_id
      WHERE offer.question_id = ${options.questionId} AND offer.decision IS NULL`.pipe(
      Effect.mapError(fail("Could not read the offer"))
    )
    const offer = rows[0]
    if (offer === undefined) return
    const [change, choices] = yield* Effect.all([
      decodeJson(PermissionChangeSchema, offer.change_json),
      decodeJson(OfferChoicesSchema, offer.choices_json)
    ]).pipe(Effect.mapError((cause) => workError("storage", "Stored offer is corrupt", cause)))
    const answer = options.answer
    const chosen =
      answer.kind === "choice"
        ? choices.find((choice) => choice.id === answer.choice_id)
        : undefined
    if (answer.kind === "choice" && chosen === undefined)
      return yield* workError("invalid", "That scope was not offered")
    if (chosen !== undefined)
      yield* saveChange({
        sql,
        change,
        chosen,
        questionId: options.questionId,
        serverName: offer.server_name
      })
    yield* sql`UPDATE permission_offers SET decision = ${chosen?.id ?? "no"}, settled_at = ${now}
      WHERE question_id = ${options.questionId}`.pipe(
      Effect.mapError(fail("Could not settle the offer"))
    )
  }
)

const saveChange = Effect.fn("PermissionOffer.saveChange")(function* (input: {
  readonly sql: SqlClient.SqlClient
  readonly change: PermissionChange
  readonly chosen: OfferChoice
  readonly questionId: string
  readonly serverName: string | null
}) {
  const { sql, change, chosen } = input
  const source = { kind: "offer", questionId: input.questionId } as const
  if (change.kind === "mode") {
    if (chosen.principal?.startsWith("chat:") !== true) return
    const sessionId = chosen.principal.slice("chat:".length)
    yield* sql`UPDATE sessions
      SET metadata = json_set(COALESCE(metadata, '{}'), '$.approval_mode', ${change.mode})
      WHERE session_id = ${sessionId}`.pipe(
      Effect.mapError(fail("Could not change the chat's approval mode"))
    )
    return
  }
  const list = offerChoiceList(chosen)
  if (list === undefined) return
  if (change.kind === "rule") {
    yield* changeRuleInTransaction(sql, {
      ruleId: change.ruleId,
      decision: change.decision,
      source,
      list
    }).pipe(
      Effect.mapError((cause) =>
        cause.reason === "not_found"
          ? workError("not_found", "That rule is gone. Nothing changed.", cause)
          : workError("storage", "Could not change the permission", cause)
      )
    )
    return
  }
  if (change.kind === "path" && change.decision === "never") {
    yield* settleGone(
      saveRuleInTransaction(sql, {
        subject: { kind: "path", path: change.path, access: change.access },
        list,
        decision: "never",
        source
      })
    )
    return
  }
  if (change.kind === "words") {
    yield* settleGone(
      saveWordsInTransaction(sql, {
        text: change.text,
        list,
        decision: change.decision,
        rules: change.rules ?? [],
        source
      })
    )
    return
  }
  const subjects = allowSubjects(change, input.serverName)
  if (subjects !== undefined) {
    yield* settleGone(saveAllowsInTransaction(sql, { subjects, list, source }))
    return
  }
  if (change.kind !== "tool") return
  yield* settleGone(
    saveRuleInTransaction(sql, {
      subject: { kind: "tool", tool: change.tool, server: input.serverName },
      list,
      decision: ruleOfSetting(change.decision),
      source
    })
  )
})

const settleGone = <A, R>(save: Effect.Effect<A, PermissionRulesError, R>) =>
  save.pipe(
    Effect.catchIf(
      (cause) => cause.reason === "not_found",
      () => Effect.void
    ),
    Effect.mapError(fail("Could not save the permission"))
  )
