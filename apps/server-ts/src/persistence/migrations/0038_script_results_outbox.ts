import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { Predicate } from "effect"
import type { Migration } from "./index.js"

interface SettledAttempt {
  readonly workflow_ref: string
  readonly attempt: number
  readonly status: string
  readonly value_json: string
  readonly error_json: string | null
  readonly source_refs_json: string
  readonly delivery_attempt_count: number
  readonly delivery_next_attempt_at: string | null
  readonly delivery_last_error: string | null
  readonly settled_at: string
  readonly origin_run_id: string
  readonly session_id: string
  readonly session_ref: string
  readonly admitted: number
}

const MAX_SOURCES = 80

const parse = (json: string | null): unknown => (json === null ? null : JSON.parse(json))

const sourceRefs = (lists: ReadonlyArray<string>): ReadonlyArray<unknown> => {
  const seen = new Map<string, unknown>()
  for (const list of lists) {
    const parsed = parse(list)
    if (!Array.isArray(parsed)) continue
    for (const source of parsed) {
      if (!Predicate.isObject(source)) continue
      const key = [source["provider"], source["kind"], source["ref"]].map(String).join("\0")
      if (!seen.has(key) && seen.size < MAX_SOURCES) seen.set(key, source)
    }
  }
  return [...seen.values()]
}

const resultText = (row: SettledAttempt): string => {
  const error = parse(row.error_json)
  if (Predicate.isObject(error) && typeof error["message"] === "string") return error["message"]
  const value = parse(row.value_json)
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

const up = (database: DatabaseSync): void => {
  const settled = database
    .prepare(
      `SELECT a.workflow_ref, a.attempt, a.status, a.value_json, a.error_json, a.source_refs_json,
        a.delivery_attempt_count, a.delivery_next_attempt_at, a.delivery_last_error,
        COALESCE(a.ended_at, a.created_at) AS settled_at,
        w.origin_run_id, s.session_id, s.public_ref AS session_ref,
        EXISTS (SELECT 1 FROM chat_idempotency_keys AS receipt
          WHERE receipt.session_id = s.session_id
            AND receipt.client_id = 'arden:workflow-result:v1:' || a.workflow_ref || ':' || a.attempt
        ) AS admitted
      FROM workflow_attempts AS a
      JOIN workflows AS w ON w.workflow_ref = a.workflow_ref
      JOIN sessions AS s ON s.public_ref = w.origin_session_ref
      WHERE a.result_delivered_at IS NULL
        AND a.status IN ('succeeded', 'failed', 'cancelled', 'needs_attention')`
    )
    .all()
    .map((row): SettledAttempt => ({
      workflow_ref: String(row.workflow_ref),
      attempt: Number(row.attempt),
      status: String(row.status),
      value_json: String(row.value_json),
      error_json: row.error_json === null ? null : String(row.error_json),
      source_refs_json: String(row.source_refs_json),
      delivery_attempt_count: Number(row.delivery_attempt_count),
      delivery_next_attempt_at:
        row.delivery_next_attempt_at === null ? null : String(row.delivery_next_attempt_at),
      delivery_last_error:
        row.delivery_last_error === null ? null : String(row.delivery_last_error),
      settled_at: String(row.settled_at),
      origin_run_id: String(row.origin_run_id),
      session_id: String(row.session_id),
      session_ref: String(row.session_ref),
      admitted: Number(row.admitted)
    }))
  const nodeSources = database.prepare(
    `SELECT attempt_node.source_refs_json FROM workflow_node_attempts AS attempt_node
      JOIN workflow_nodes AS node
        ON node.workflow_ref = attempt_node.workflow_ref
        AND node.logical_key = attempt_node.logical_key
      WHERE attempt_node.workflow_ref = ? AND attempt_node.attempt = ?
      ORDER BY node.position, attempt_node.logical_key`
  )
  const insert = database.prepare(
    `INSERT INTO automation_deliveries (
      delivery_id, task_id, delivered_at, subject, body, payload, status, created_at,
      destinations, attempt_count, next_attempt_at, last_error
    ) VALUES (?, NULL, NULL, 'Script result', ?, ?, 'pending', ?, '[]', ?, ?, ?)
    ON CONFLICT(delivery_id) DO NOTHING`
  )
  for (const row of settled) {
    if (row.admitted === 1) continue
    const nodes = nodeSources
      .all(row.workflow_ref, row.attempt)
      .map((node) => String(node.source_refs_json))
    const error = parse(row.error_json)
    const preview =
      Predicate.isObject(error) && typeof error.preview === "string" ? error.preview : null
    const payload = {
      kind: "script_result",
      sessionId: row.session_id,
      sessionRef: row.session_ref,
      originRunId: row.origin_run_id,
      workflowRef: row.workflow_ref,
      attempt: row.attempt,
      status: row.status,
      preview,
      sourceRefs: sourceRefs([row.source_refs_json, ...nodes])
    }
    insert.run(
      createHash("sha256").update(`script-result:${row.workflow_ref}:${row.attempt}`).digest("hex"),
      resultText(row),
      JSON.stringify(payload),
      row.settled_at,
      row.delivery_attempt_count,
      row.delivery_next_attempt_at,
      row.delivery_last_error
    )
  }
  database.exec(`UPDATE workflow_attempts SET result_delivered_at = COALESCE(ended_at, created_at)
    WHERE result_delivered_at IS NULL
      AND status IN ('succeeded', 'failed', 'cancelled', 'needs_attention')`)
}

export const scriptResultsOutbox: Migration = {
  version: 38,
  name: "script_results_outbox",
  foreignKeys: { kind: "enforced" },
  up
}
