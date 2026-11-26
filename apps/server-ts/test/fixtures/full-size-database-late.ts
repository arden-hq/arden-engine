import { backfills } from "../../src/persistence/sqlite/backfills/index.js"

export interface SeedScope {
  readonly at: (seconds: string) => string
  readonly pad: (width: number, expression: string) => string
  readonly t0: number
  readonly span: number
  readonly SPAN: number
  readonly SPACES: number
  readonly SPACE_TASKS: number
  readonly SPACE_TASK_EVENTS: number
  readonly OPEN_TASKS: number
  readonly growsWithHistory: (count: number) => number
}

export const lateSteps = ({
  at,
  pad,
  t0,
  span,
  SPAN,
  SPACES,
  SPACE_TASKS,
  SPACE_TASK_EVENTS,
  OPEN_TASKS,
  growsWithHistory
}: SeedScope): ReadonlyArray<string> => [
  `INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner, runs_in, created_at,
     updated_at, completed_at, created_by)
   SELECT 'item-' || ${pad(5, "n")}, 'space-' || ${pad(2, `n % ${SPACES - 2}`)}, 'task-' || n,
     'Follow up on item ' || n,
     CASE WHEN n >= ${SPACE_TASKS - OPEN_TASKS} THEN 'open' WHEN n % 10 < 9 THEN 'done' ELSE 'cancelled' END,
     CASE WHEN n % 3 = 0 THEN 'user' ELSE 'worker' END, 'background',
     ${at(`n * ${span} / ${SPACE_TASKS}`)}, ${at(`n * ${span} / ${SPACE_TASKS} + 3600`)},
     CASE WHEN n < ${SPACE_TASKS - OPEN_TASKS} THEN ${at(`n * ${span} / ${SPACE_TASKS} + 3600`)} END, 'user'
   FROM nums WHERE n < ${SPACE_TASKS}`,
  `INSERT INTO space_task_events (space_id, item_id, event_type, summary, created_at)
   SELECT t.space_id, t.item_id,
     CASE e.n % 5 WHEN 0 THEN 'created' WHEN 1 THEN 'updated' WHEN 2 THEN 'scheduled'
       WHEN 3 THEN 'reported' ELSE CASE WHEN t.status = 'done' THEN 'done' ELSE 'updated' END END,
     'Step ' || e.n || ' on ' || t.item_id, ${at(`e.n * ${span} / ${SPACE_TASK_EVENTS}`)}
   FROM nums AS e JOIN space_tasks AS t ON t.item_id = 'item-' || ${pad(5, `e.n % ${SPACE_TASKS}`)}
   WHERE e.n < ${SPACE_TASK_EVENTS} ORDER BY e.n`,

  `INSERT INTO usage_daily (day, space_id, origin, session_type, model_id, kind, total_tokens,
     output_tokens, cache_read_tokens, cache_write_tokens, runs)
   SELECT strftime('%Y-%m-%d', ${t0} + d.n * 86400, 'unixepoch'), '',
     CASE WHEN c.n < 8 THEN 'user' ELSE 'automation' END,
     CASE c.n % 3 WHEN 0 THEN 'chat' WHEN 1 THEN 'agent' ELSE 'channel' END,
     CASE WHEN c.n % 2 = 0 THEN 'claude-sonnet-4-5' ELSE 'gpt-5' END,
     CASE c.n % 5 WHEN 0 THEN 'chat' WHEN 1 THEN 'chat_title' WHEN 2 THEN 'compaction'
       WHEN 3 THEN 'letter_subject' ELSE 'run_activity' END,
     50000 + c.n * 1000, 3000, 40000, 2000, 5 + c.n
   FROM nums AS d JOIN nums AS c ON c.n < 15 WHERE d.n < ${SPAN}`,

  `INSERT INTO chat_idempotency_keys (session_id, client_id, request_hash, run_id, message_id, status,
     created_at, updated_at)
   SELECT session_id, 'client-' || run_id, 'hash-' || idx, run_id, run_id || '-u',
     CASE status WHEN 'completed' THEN 'completed' WHEN 'error' THEN 'error' ELSE status END,
     ${at("start_s")}, ${at("start_s + 40")}
   FROM runs`,
  `INSERT INTO execution_budgets (budget_id, generation, tokens_used, focus_session_id)
   SELECT 'budget-' || idx, 0, 20000 + idx % 5000, session_id FROM runs WHERE idx < ${growsWithHistory(9_700)}`,
  `INSERT INTO run_sidecars (run_id, session_id, updated_at)
   SELECT run_id, session_id, ${at("start_s + 60")} FROM runs WHERE kind <> 'user' LIMIT ${growsWithHistory(5_100)}`,
  `INSERT INTO tool_call_targets (run_id, tool_call_id, source, object_id, at, title, href)
   SELECT run_id, tool_call_id, 'web', 'https://example.com/' || rowid, started_at, 'Page ' || rowid,
     'https://example.com/' || rowid
   FROM tool_calls WHERE tool_name = 'web_fetch' LIMIT ${growsWithHistory(4_900)}`,
  `INSERT INTO approval_reviews (run_id, tool_call_id, session_id, tool_name, reviewed_at, rung, decision,
     decided_by, verdict, risk, user_authorization, authorization_source, policy_category)
   SELECT run_id, tool_call_id, session_id, tool_name, started_at, 'default', 'allow', 'outcome', 'allow',
     'low', 'high', 'owner', 'none'
   FROM tool_calls WHERE changes_state = 1 LIMIT ${growsWithHistory(4_200)}`,
  `INSERT INTO letter_subjects (session_id, message_id, subject)
   SELECT session_id, run_id || '-a2', 'Report on ' || run_id FROM runs
   WHERE kind IN ('fork', 'thread', 'user') ORDER BY idx DESC LIMIT ${growsWithHistory(7_000)}`,
  `INSERT INTO home_presence (client_id, sequence, last_seen_at, lease_until)
   SELECT 'device-' || n, n, ${at(`n * ${span} / ${growsWithHistory(2_400)}`)}, ${at(`n * ${span} / ${growsWithHistory(2_400)} + 60`)}
   FROM nums WHERE n < ${growsWithHistory(2_400)}`,
  `INSERT INTO browser_procedure_settings (singleton, enabled, since)
   VALUES (1, 1, ${at("0")})
   ON CONFLICT(singleton) DO UPDATE SET enabled = 1, since = excluded.since`,
  `CREATE TEMP TABLE trimmed AS SELECT session_id, run_id FROM runs
   WHERE kind = 'fork' AND start_s + 130 < ${span} - 7 * 86400 - 3600`,
  `DELETE FROM session_messages WHERE session_id IN (SELECT session_id FROM trimmed)
     AND message_id NOT IN (SELECT run_id || '-a2' FROM trimmed)`,
  `UPDATE session_messages SET seq = 0 WHERE session_id IN (SELECT session_id FROM trimmed)`,
  `DELETE FROM session_turns WHERE session_id IN (SELECT session_id FROM trimmed)`,
  `DELETE FROM tool_calls WHERE session_id IN (SELECT session_id FROM trimmed)`,
  `DELETE FROM chat_idempotency_keys WHERE session_id IN (SELECT session_id FROM trimmed)`,
  `DELETE FROM run_sidecars WHERE session_id IN (SELECT session_id FROM trimmed)`,
  `DELETE FROM trace_trim_due WHERE session_id IN (SELECT session_id FROM trimmed)`,
  `UPDATE sessions SET context_generation = 1, active_message_count = 1, visible_message_count = 1,
     metadata = json_set(metadata, '$.agent_trace_retained_at', last_activity,
       '$.agent_trace_retained_run_id', (SELECT run_id FROM trimmed WHERE trimmed.session_id = sessions.session_id))
   WHERE session_id IN (SELECT session_id FROM trimmed)`,
  `DROP TABLE trimmed`,
  `INSERT OR REPLACE INTO data_backfills (name, converted, started_at, updated_at, finished_at)
   SELECT value, 0, ${at("0")}, ${at("0")}, ${at("0")}
   FROM json_each('${JSON.stringify(backfills.map((backfill) => backfill.name))}')`
]
