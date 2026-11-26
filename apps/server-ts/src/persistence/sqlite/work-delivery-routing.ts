import { parseJsonText } from "@arden-hq/protocol/common"
import { Effect } from "effect"
import { type RunDeliveryPayload } from "../deliveries/model.js"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { userContent } from "../transcript/user-content.js"
import { workError } from "./work-records.js"
import { takesAnswersMidRunSql } from "./authority-sql.js"
import { activeRunStatusList } from "./status-sets.js"
import { iso } from "../../runtime/clock.js"
import { sha256Hex } from "@arden-hq/std/hash"
import type { Row } from "effect/unstable/sql/SqlConnection"

export const unroutableSummary =
  "A worker result could not be delivered because no visible parent conversation remains."

const TURN_DELIVERY_KINDS: ReadonlyArray<RunDeliveryPayload["kind"]> = [
  "answer",
  "result",
  "thread",
  "connection",
  "update"
]

export const turnDeliveryKindSql = (
  sql: SqlClient.SqlClient,
  payload: Statement.Fragment
): Statement.Statement<Row> =>
  sql`json_extract(${payload}, '$.kind') IN ${sql.in(TURN_DELIVERY_KINDS)}`

export const deliverySourceSql = (
  sql: SqlClient.SqlClient,
  payload: Statement.Fragment
): Statement.Statement<Row> =>
  sql`COALESCE(json_extract(${payload}, '$.runIds[0]'), json_extract(${payload}, '$.source.runId'),
    json_extract(${payload}, '$.source.key'))`

export const childAgentResult = (
  sql: SqlClient.SqlClient,
  payload: string | Statement.Fragment
): Statement.Statement<Row> => sql`
  json_extract(${payload}, '$.kind') = 'result'
  AND EXISTS (SELECT 1 FROM chat_runs AS child_run
    JOIN sessions AS child ON child.session_id = child_run.session_id
    WHERE child_run.run_id = json_extract(${payload}, '$.runIds[0]')
      AND child.session_type = 'agent'
      AND child.parent_session_id = json_extract(${payload}, '$.sessionId'))`

const SIBLING_HOLD_MS = 10 * 60_000

export const awaitsSiblingAgents = (
  sql: SqlClient.SqlClient,
  payload: string | Statement.Fragment,
  createdAt: string | Statement.Fragment,
  now: string
): Statement.Statement<Row> => sql`
  (${childAgentResult(sql, payload)})
  AND ${createdAt} > ${iso(Date.parse(now) - SIBLING_HOLD_MS)}
  AND EXISTS (SELECT 1 FROM sessions AS sibling
    JOIN chat_runs AS sibling_run ON sibling_run.session_id = sibling.session_id
    WHERE sibling.parent_session_id = json_extract(${payload}, '$.sessionId')
      AND sibling.session_type = 'agent'
      AND sibling.archived_at IS NULL
      AND sibling_run.status IN ${activeRunStatusList}
      AND sibling_run.run_id <> json_extract(${payload}, '$.runIds[0]'))`

const answerToAskingRun = (
  sql: SqlClient.SqlClient,
  payload: string | Statement.Fragment,
  runId: Statement.Fragment
) => sql`
  json_extract(${payload}, '$.kind') = 'answer'
  AND ${runId} = json_extract(${payload}, '$.runIds[0]')
  AND EXISTS (SELECT 1 FROM chat_runs AS asking
    JOIN sessions AS asking_chat ON asking_chat.session_id = asking.session_id
    WHERE asking.run_id = ${runId}
      AND (json_extract(${payload}, '$.timeout') = 1 OR ${takesAnswersMidRunSql(sql, sql`asking.authority_json`, sql`asking_chat.session_type = 'agent'`)}))`

export const steersRun = (
  sql: SqlClient.SqlClient,
  payload: string | Statement.Fragment,
  runId: Statement.Fragment
): Statement.Statement<Row> =>
  sql`(${childAgentResult(sql, payload)}) OR (${answerToAskingRun(sql, payload, runId)})`

export const threadDeliveryOwner = Effect.fn("WorkDeliveries.threadOwner")(function* (
  sql: SqlClient.SqlClient,
  payload: Extract<RunDeliveryPayload, { readonly kind: "thread" }>
) {
  const rows = yield* sql<{
    readonly source_ref: string
    readonly source_name: string | null
    readonly target_ref: string
  }>`SELECT source.public_ref AS source_ref, source.name AS source_name,
      target.public_ref AS target_ref
    FROM focus_choices AS choice
    JOIN sessions AS source ON source.session_id = choice.source_session_id
    JOIN sessions AS target ON target.session_id = choice.result_session_id
    WHERE choice.question_id = ${payload.questionId}
      AND choice.decision = 'open_target'
      AND choice.result_session_id = ${payload.sessionId}
      AND choice.revision = ${payload.revision}`
  const owner = rows[0]
  if (owner === undefined)
    return yield* workError("conflict", "The thread no longer lives in this chat")
  const forwarded = yield* sql<{ readonly message_json: string }>`SELECT message_json
    FROM session_messages
    WHERE session_id = ${payload.forwarded.sessionId}
      AND message_id = ${payload.forwarded.messageId}`
  const stored: unknown =
    forwarded[0] === undefined ? undefined : parseJsonText(forwarded[0].message_json)
  const content =
    typeof stored === "object" && stored !== null && "content" in stored
      ? stored.content
      : undefined
  return {
    ...owner,
    source_name: owner.source_name ?? "Source chat",
    images: userContent(content).images
  }
})

export const enqueueRunDelivery = Effect.fn(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly eventId: string
  readonly subject: string
  readonly body: string
  readonly payload: RunDeliveryPayload
  readonly now: string
}) {
  const deliveryId = sha256Hex(options.eventId)
  yield* options.sql`INSERT INTO automation_deliveries (
    delivery_id, task_id, delivered_at, subject, body, payload, status, created_at, destinations
  ) VALUES (${deliveryId}, NULL, NULL, ${options.subject}, ${options.body}, ${JSON.stringify(options.payload)},
    'pending', ${options.now}, '[]') ON CONFLICT(delivery_id) DO NOTHING`.pipe(
    Effect.mapError((cause) => workError("storage", "Could not queue the Run delivery", cause))
  )
  return deliveryId
})

export const arrivalText = (content: unknown): string =>
  typeof content === "string" ? content : userContent(content).text

export const arrivalIdentitySql = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  content: unknown
): Statement.Statement<Row> =>
  sql`payload IS NOT NULL AND ${turnDeliveryKindSql(sql, sql`payload`)}
    AND json_extract(payload, '$.sessionId') = ${sessionId} AND body = ${arrivalText(content)}`
