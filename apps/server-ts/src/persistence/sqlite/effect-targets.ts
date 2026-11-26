import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"

import {
  EFFECT_TARGET_ORIGIN,
  MAX_CALL_TARGETS,
  type EffectTarget,
  type EffectTargetOrigin
} from "../../execution/tool-effect.js"
import type { CallTarget } from "../tools/change-evidence.js"
import { boundedLabel, boundedPlace } from "../tools/mutation-receipt.js"
import { causedChainDepth } from "../automations/chain-depth.js"
import type { ObjectTouch } from "../automations/model.js"
import { iso } from "../../runtime/clock.js"
import { causingAutomation, causingWakeDepth } from "./run-cause.js"
import { touchingToolStatusList } from "./status-sets.js"

const CLOCK_SKEW_MS = 2 * 60_000

export const EFFECT_TARGET_RESULT = {
  notRunning: "not_running",
  tooMany: "too_many",
  stored: "stored"
} as const
type EffectTargetResult = (typeof EFFECT_TARGET_RESULT)[keyof typeof EFFECT_TARGET_RESULT]

export const storeEffectTarget = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly runId: string
    readonly toolCallId: string
    readonly target: EffectTarget
    readonly origin: EffectTargetOrigin
  },
  at: string
): Effect.fn.Return<EffectTargetResult, SqlError.SqlError> {
  const [call] = yield* sql<{ readonly others: number }>`
    SELECT (SELECT count(*) FROM tool_call_targets AS target
      WHERE target.run_id = call.run_id AND target.tool_call_id = call.tool_call_id
        AND NOT (target.source = ${input.target.source}
          AND target.object_id = ${input.target.objectId})) AS others
    FROM tool_calls AS call
    WHERE call.run_id = ${input.runId} AND call.tool_call_id = ${input.toolCallId}
      AND call.status = 'running'`
  if (call === undefined) return EFFECT_TARGET_RESULT.notRunning
  if (call.others >= MAX_CALL_TARGETS) return EFFECT_TARGET_RESULT.tooMany
  const label = boundedLabel(input.target)
  const title = label.title ?? null
  const href = label.href ?? null
  const place = boundedPlace(input.target.place) ?? null
  const onConflict =
    input.origin === EFFECT_TARGET_ORIGIN.named
      ? sql`DO UPDATE SET at = excluded.at, title = excluded.title, href = excluded.href,
          place = excluded.place, origin = excluded.origin`
      : sql`DO UPDATE SET title = COALESCE(tool_call_targets.title, excluded.title),
          href = COALESCE(tool_call_targets.href, excluded.href),
          place = COALESCE(tool_call_targets.place, excluded.place)`
  yield* sql`
    INSERT INTO tool_call_targets (run_id, tool_call_id, source, object_id, at, title, href, place, origin)
    VALUES (${input.runId}, ${input.toolCallId}, ${input.target.source}, ${input.target.objectId},
      ${at}, ${title}, ${href}, ${place}, ${input.origin})
    ON CONFLICT (run_id, tool_call_id, source, object_id) ${onConflict}`
  return EFFECT_TARGET_RESULT.stored
})

export const readEffectTargets = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  identity: { readonly runId: string; readonly toolCallId: string }
) {
  const read = yield* readEffectTargetsOf(sql, identity.runId, [identity.toolCallId])
  return read.get(identity.toolCallId) ?? []
})

export const readEffectTargetsOf = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  toolCallIds: ReadonlyArray<string>
) {
  const read = new Map<string, Array<CallTarget>>()
  if (toolCallIds.length === 0) return read
  const rows = yield* sql<{
    readonly tool_call_id: string
    readonly source: string
    readonly object_id: string
    readonly title: string | null
    readonly href: string | null
    readonly place: string | null
    readonly origin: EffectTargetOrigin
  }>`SELECT tool_call_id, source, object_id, title, href, place, origin FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY tool_call_id ORDER BY at, source, object_id
      ) AS n
      FROM tool_call_targets
      WHERE run_id = ${runId} AND tool_call_id IN ${sql.in(toolCallIds)}
    ) WHERE n <= ${MAX_CALL_TARGETS}
    ORDER BY tool_call_id, n`
  for (const row of rows) {
    const targets = read.get(row.tool_call_id) ?? []
    targets.push({
      source: row.source,
      objectId: row.object_id,
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.href === null ? {} : { href: row.href }),
      ...(row.place === null ? {} : { place: row.place }),
      origin: row.origin
    })
    read.set(row.tool_call_id, targets)
  }
  return read
})

export const touchCause = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  touch: ObjectTouch
) {
  const changedMs = Date.parse(touch.changedAt)
  if (Number.isNaN(changedMs)) return undefined
  const [row] = yield* sql<{ readonly produced_by: string; readonly chain_depth: number }>`
    SELECT ${causingAutomation(sql, "run")} AS produced_by,
      ${causingWakeDepth(sql, "run")} AS chain_depth
    FROM tool_call_targets AS target
    JOIN tool_calls AS call
      ON call.run_id = target.run_id AND call.tool_call_id = target.tool_call_id
    JOIN chat_runs AS run ON run.run_id = target.run_id
    WHERE target.source = ${touch.target.source} AND target.object_id = ${touch.target.objectId}
      AND target.at <= ${iso(changedMs + CLOCK_SKEW_MS)}
      AND (call.ended_at IS NULL OR call.ended_at >= ${iso(changedMs - CLOCK_SKEW_MS)})
      AND (call.status IN ${touchingToolStatusList}
        OR json_extract(call.result_json, '$.host.mutation_receipt.outcome') IN ('applied', 'unconfirmed'))
      AND ${causingAutomation(sql, "run")} IS NOT NULL
    ORDER BY target.at DESC
    LIMIT 1`
  return row === undefined
    ? undefined
    : {
        producedBy: row.produced_by,
        chainDepth: causedChainDepth(row.produced_by, row.chain_depth)
      }
})
