import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { backfills } from "../../src/persistence/sqlite/backfills/index.js"

/**
 * Fills an initialized Arden database to about the size of a five-month
 * owner database, in the same shape: a few hundred chats, thousands of
 * Automation forks, agents and channels, and the rows that hang off their
 * runs. Everything goes in with bulk SQL, with triggers and foreign keys on,
 * so the tables the triggers keep (session_sizes, row_counts, trace_trim_due,
 * session_revisions, message_turns, automation_delivery_runs, the search
 * change list) come out as the app would leave them.
 *
 * The file must already hold the current schema and the rows a first start
 * writes (start the server on it once); this only adds the history.
 */

/** Real ids from the seeded rows, for calling routes with ids that exist. */
export interface FullSizeIds {
  /** A user chat with many runs. */
  readonly chat: string
  readonly chatRun: string
  /** The user message that started `chatRun`: its turn id. */
  readonly chatTurn: string
  readonly chatToolCall: string
  /** The chat an Automation with thousands of runs forks from. */
  readonly thread: string
  readonly fork: string
  readonly forkRun: string
  readonly agent: string
  readonly agentRun: string
  readonly channel: string
  readonly space: string
  /** The Automation with the most runs. */
  readonly busyAutomation: string
  /** An Automation that runs in its own chat. */
  readonly freshAutomation: string
  readonly taskItem: string
}

const DAY = 86_400
/** Days of history at scale 1. */
const SPAN_DAYS = 150
/** Open Tasks and open questions: what is waiting now does not grow with history. */
const OPEN_TASKS = 120
const OPEN_QUESTIONS = 25

/** Message id suffix of the n-th message of a turn (m.n). */
const MESSAGE_SUFFIX = `CASE m.n WHEN 0 THEN '-u' WHEN 1 THEN '-a1' WHEN 2 THEN '-t1' WHEN 3 THEN '-a3' WHEN 4 THEN '-t3' ELSE '-a2' END`

/** Filler text of `length` characters, so rows are as wide as real ones. */
const text = (length: number) =>
  `substr(replace(hex(zeroblob(${Math.ceil(length / 14) + 1})), '0', 'checked item '), 1, ${length})`

const pad = (width: number, expression: string) => `printf('%0${width}d', ${expression})`

export interface SeedOptions {
  /** 1 is about the owner's five-month database; 4 is four times the history. */
  readonly scale?: number
  readonly now?: number
}

export const seedFullSizeDatabase = (filename: string, options: SeedOptions = {}): FullSizeIds => {
  const scale = options.scale ?? 1
  const now = options.now ?? Date.now()
  // Scale stretches the history: the same rate of chats, runs and
  // Automation runs over `scale` times as many days. What one chat holds,
  // what is open now and what happened this week stay the same.
  const size = (count: number) => Math.round(count * scale)
  const SPAN = SPAN_DAYS * scale
  const USER_CHATS = size(250)
  const USER_RUNS = size(9_000)
  const FORK_RUNS = size(3_500)
  const THREAD_RUNS = size(1_070)
  const AGENTS = size(1_100)
  const CHANNELS = size(190)
  const CHANNEL_RUNS = size(1_330)
  const AUTOMATIONS = 12
  // Three Automations hold most runs; the other nine share the rest.
  const BIG_AUTOMATION_RUNS = size(10_500)
  const TASK_AUTOMATION_RUNS = size(17_000)
  const AUTOMATION_RUNS = size(20_000)
  const SPACES = 20
  const SPACE_TASKS = size(300)
  const SPACE_TASK_EVENTS = size(2_000)
  const QUESTIONS = size(450)
  /** Space reviews of space-00: about one an hour, like the owner's reviewer. */
  const SPACE_REVIEWS = size(3_500)

  const FORK_FROM = USER_RUNS
  const THREAD_FROM = FORK_FROM + FORK_RUNS
  const AGENT_FROM = THREAD_FROM + THREAD_RUNS
  const CHANNEL_FROM = AGENT_FROM + AGENTS
  const RUNS = CHANNEL_FROM + CHANNEL_RUNS
  // Automation runs from this index on fork a chat; older forks are gone.
  const FORK_AUTOMATION_FROM = BIG_AUTOMATION_RUNS - FORK_RUNS
  // Automation runs from this index on ran in their own chat.
  const THREAD_AUTOMATION_FROM = TASK_AUTOMATION_RUNS - THREAD_RUNS

  const end = Math.floor(now / 1000) - 1_800
  const t0 = end - SPAN * DAY
  const span = end - t0
  /** An ISO time `seconds` after the start of the history. */
  const at = (seconds: string) =>
    `strftime('%Y-%m-%dT%H:%M:%fZ', ${t0} + (${seconds}), 'unixepoch')`
  const runId = (idx: string) => `'run-' || ${pad(5, idx)}`
  const automationId = (task: string) => `'auto-' || ${pad(2, task)}`
  const threadId = (task: string) => `'thread-' || ${pad(2, task)}`
  // An Automation run's outcome, spread evenly by a hash of its index.
  const outcome = (a: string) => `CASE
      WHEN (${a}) * 37 % 100 < 2 THEN 'failed'
      WHEN (${a}) * 37 % 100 = 2 THEN 'cancelled'
      WHEN (${a}) * 37 % 100 = 3 AND (${a}) / 100 % 2 = 0 THEN 'interrupted'
      WHEN (${a}) * 37 % 100 < 40 THEN 'no_change'
      WHEN (${a}) * 37 % 100 < 42 THEN 'needs_you'
      ELSE 'finished' END`
  const automationStart = (a: string) => `CASE WHEN (${a}) < ${BIG_AUTOMATION_RUNS}
      THEN (${a}) * ${span} / ${BIG_AUTOMATION_RUNS}
      ELSE ((${a}) - ${BIG_AUTOMATION_RUNS}) * ${span} / ${TASK_AUTOMATION_RUNS - BIG_AUTOMATION_RUNS} END`
  const automationTask = (a: string) => `CASE WHEN (${a}) < ${BIG_AUTOMATION_RUNS} THEN (${a}) % 3
      ELSE 3 + ((${a}) - ${BIG_AUTOMATION_RUNS}) % ${AUTOMATIONS - 3} END`

  const database = new DatabaseSync(filename)
  try {
    database.exec("PRAGMA foreign_keys = ON")
    database.exec("BEGIN IMMEDIATE")
    const steps: ReadonlyArray<string> = [
      `CREATE TEMP TABLE nums (n INTEGER PRIMARY KEY)`,
      `INSERT INTO nums WITH RECURSIVE c(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM c WHERE n < 199999)
         SELECT n FROM c`,

      // Every run, with the chat it ran in and its place in that chat.
      // kind: user (a person's chat), fork (an Automation's fork of its chat),
      // thread (an Automation run in its own chat), agent, channel.
      `CREATE TEMP TABLE runs (
         idx INTEGER PRIMARY KEY, run_id TEXT, kind TEXT, session_id TEXT, k INTEGER,
         first_k INTEGER, start_s INTEGER, a INTEGER, task INTEGER, status TEXT, outcome TEXT,
         parent_idx INTEGER)`,
      `INSERT INTO runs (idx, kind, session_id, k, first_k, start_s, a, task, parent_idx)
       SELECT n, 'user', 'chat-' || ${pad(4, `n % ${USER_CHATS}`)}, n / ${USER_CHATS}, 0,
         n * ${span} / ${USER_RUNS} + n * 7919 % 600, NULL, NULL, NULL
       FROM nums WHERE n < ${USER_RUNS}`,
      `INSERT INTO runs (idx, kind, session_id, k, first_k, start_s, a, task, parent_idx)
       SELECT n, 'fork', ${threadId(`(n - ${FORK_FROM} + ${FORK_AUTOMATION_FROM}) % 3`)}
           || '::f' || (n - ${FORK_FROM} + ${FORK_AUTOMATION_FROM} + 1),
         3, 3, ${automationStart(`n - ${FORK_FROM} + ${FORK_AUTOMATION_FROM}`)} + 20,
         n - ${FORK_FROM} + ${FORK_AUTOMATION_FROM}, (n - ${FORK_FROM} + ${FORK_AUTOMATION_FROM}) % 3, NULL
       FROM nums WHERE n >= ${FORK_FROM} AND n < ${THREAD_FROM}`,
      `INSERT INTO runs (idx, kind, session_id, k, first_k, start_s, a, task, parent_idx)
       SELECT n, 'thread', ${threadId(automationTask(`n - ${THREAD_FROM} + ${THREAD_AUTOMATION_FROM}`))},
         3 + (n - ${THREAD_FROM}) / ${AUTOMATIONS - 3}, 3,
         ${automationStart(`n - ${THREAD_FROM} + ${THREAD_AUTOMATION_FROM}`)} + 20,
         n - ${THREAD_FROM} + ${THREAD_AUTOMATION_FROM},
         ${automationTask(`n - ${THREAD_FROM} + ${THREAD_AUTOMATION_FROM}`)}, NULL
       FROM nums WHERE n >= ${THREAD_FROM} AND n < ${AGENT_FROM}`,
      // Each agent was started by a tool call of a user run.
      `INSERT INTO runs (idx, kind, session_id, k, first_k, start_s, a, task, parent_idx)
       SELECT n, 'agent', 'agent-' || ${pad(4, `n - ${AGENT_FROM}`)}, 0, 0,
         (n - ${AGENT_FROM}) * 8 * ${span} / ${USER_RUNS} + (n - ${AGENT_FROM}) * 8 * 7919 % 600 + 30,
         NULL, NULL, (n - ${AGENT_FROM}) * 8
       FROM nums WHERE n >= ${AGENT_FROM} AND n < ${CHANNEL_FROM}`,
      `INSERT INTO runs (idx, kind, session_id, k, first_k, start_s, a, task, parent_idx)
       SELECT n, 'channel', 'channel-' || ${pad(3, `(n - ${CHANNEL_FROM}) % ${CHANNELS}`)},
         (n - ${CHANNEL_FROM}) / ${CHANNELS}, 0, (n - ${CHANNEL_FROM}) * ${span} / ${CHANNEL_RUNS}, NULL, NULL, NULL
       FROM nums WHERE n >= ${CHANNEL_FROM} AND n < ${RUNS}`,
      `UPDATE runs SET run_id = ${runId("idx")},
         outcome = CASE WHEN a IS NULL THEN 'finished' ELSE ${outcome("a")} END`,
      `UPDATE runs SET status = CASE
         WHEN outcome = 'failed' THEN 'error'
         WHEN outcome IN ('cancelled', 'interrupted') THEN outcome
         WHEN kind = 'user' AND idx % ${USER_CHATS} = 7 THEN 'cancelled'
         WHEN kind = 'agent' AND idx % 100 = 5 THEN 'error'
         ELSE 'completed' END`,

      // Spaces and their Tasks.
      `INSERT INTO spaces (space_id, name, name_key, created_at, updated_at, archived_at)
       SELECT 'space-' || ${pad(2, "n")}, 'Space ' || n, 'space ' || n, ${at("n * 3600")},
         ${at(`${span} - n * 3600`)}, CASE WHEN n >= ${SPACES - 2} THEN ${at(`${span} - 86400`)} END
       FROM nums WHERE n < ${SPACES}`,

      // Chats: a person's chats, one chat per Automation, forks, agents, channels.
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, name, archived_at,
         session_type, space_id, chat_model, context_from_seq)
       SELECT 'chat-' || ${pad(4, "n")}, 'ref-chat-' || ${pad(4, "n")}, ${at(`n * 60`)}, ${at("n * 60")},
         'Chat ' || n, CASE WHEN n % 10 = 9 THEN ${at(`${span} - 7200`)} END, 'chat',
         CASE WHEN n % 5 < 2 THEN 'space-' || ${pad(2, `n % ${SPACES - 2}`)} END, 'claude-sonnet-4-5', 0
       FROM nums WHERE n < ${USER_CHATS}`,
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, name, session_type,
         chat_model, context_from_seq)
       SELECT ${threadId("n")}, 'ref-thread-' || ${pad(2, "n")}, ${at("n * 60")}, ${at("n * 60")},
         'Automation ' || n, 'chat', 'claude-sonnet-4-5', 0
       FROM nums WHERE n < ${AUTOMATIONS}`,
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type,
         origin_automation_id, parent_session_id, parent_message_id, chat_model, metadata, context_from_seq)
       SELECT r.session_id, 'ref-fork-' || r.a, ${at("r.start_s - 10")}, ${at("r.start_s")}, 'chat',
         ${automationId("r.task")}, ${threadId("r.task")}, ${threadId("r.task")} || '-i2-a2',
         'claude-sonnet-4-5',
         json_object('fork_origin', json_object('sourceSessionId', ${threadId("r.task")},
           'sourceSessionRef', 'ref-thread-' || ${pad(2, "r.task")}, 'throughSequence', 17,
           'sourceMessageId', ${threadId("r.task")} || '-i2-a2', 'createdAt', ${at("r.start_s - 10")})),
         0
       FROM runs AS r WHERE r.kind = 'fork'`,
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type,
         parent_session_id, parent_run_id, parent_tool_call_id, chat_model, metadata, context_from_seq)
       SELECT r.session_id, 'ref-' || r.session_id, ${at("r.start_s - 5")}, ${at("r.start_s")}, 'agent',
         p.session_id, p.run_id, 'call-' || p.idx || '-0', 'claude-sonnet-4-5',
         json_object('agent', json_object('mode', CASE WHEN r.idx % 4 = 0 THEN 'code' ELSE 'research' END)),
         0
       FROM runs AS r JOIN runs AS p ON p.idx = r.parent_idx WHERE r.kind = 'agent'`,
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, name, session_type,
         chat_model, context_from_seq)
       SELECT 'channel-' || ${pad(3, "n")}, 'ref-channel-' || ${pad(3, "n")}, ${at("n * 120")},
         ${at("n * 120")}, 'Channel ' || n, 'channel', 'claude-sonnet-4-5', 0
       FROM nums WHERE n < ${CHANNELS}`,

      // The Automations: three fork their chat on every run and hold most runs.
      `INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, model, context_mode, triggers,
         enabled, created_at, last_run_at, next_run_at, last_result, thread_id, tool_scope, purpose,
         prompt_author)
       SELECT ${automationId("n")}, 'ref-auto-' || ${pad(2, "n")}, 'Automation ' || n,
         'Check the news and report anything new.', 'claude-sonnet-4-5', 'continue',
         CASE WHEN n < 3 THEN '[{"type":"time","every":"1h"}]' ELSE '[{"type":"time","every":"1d"}]' END,
         CASE WHEN n = ${AUTOMATIONS - 1} THEN 0 ELSE 1 END, ${at("n * 60")}, ${at(`${span} - 600`)},
         strftime('%Y-%m-%dT%H:%M:%fZ', ${end} + 1800 + 86400, 'unixepoch'), 'Nothing new.',
         ${threadId("n")}, 'read_only', 'user_automation', 'owner'
       FROM nums WHERE n < ${AUTOMATIONS}`,
      // Automations 3 and on run in their own chat.
      `UPDATE scheduled_tasks SET context_mode = 'fresh' WHERE task_id >= ${automationId("3")}`,

      `INSERT INTO chat_runs (run_id, session_id, status, stop_reason, started_at, updated_at, ended_at,
         last_seq, metadata_json, error_code, error_message, client_id, assistant_message_id, model_id)
       SELECT r.run_id, r.session_id, r.status,
         CASE WHEN r.status = 'interrupted' THEN 'server_restart' END,
         ${at("r.start_s")}, ${at("r.start_s + 40 + r.idx % 90")}, ${at("r.start_s + 40 + r.idx % 90")},
         (r.k - r.first_k) * 7 + 7,
         CASE WHEN r.a IS NOT NULL AND r.kind IN ('fork', 'thread') THEN json_object(
             'turn_id', r.run_id || '-u',
             'run_context', json_object('origin', json_object('kind', 'automation',
               'automation_id', ${automationId("r.task")}, 'occurrence_id', 'occ-' || r.a), 'task', NULL),
             'automation', json_object('task_id', ${automationId("r.task")}, 'name', 'Automation ' || r.task,
               'context_mode', CASE WHEN r.kind = 'fork' THEN 'fork' ELSE 'fresh' END))
           ELSE json_object('turn_id', r.run_id || '-u',
             'run_context', json_object('origin', json_object('kind', 'chat', 'session_id', r.session_id,
               'turn_id', r.run_id || '-u'), 'task', NULL)) END,
         CASE WHEN r.status = 'error' THEN 'provider_error' END,
         CASE WHEN r.status = 'error' THEN 'The model provider did not answer.' END,
         CASE WHEN r.kind IN ('user', 'channel') THEN 'client-' || r.run_id END,
         r.run_id || '-a2', CASE WHEN r.idx % 3 = 0 THEN 'gpt-5' ELSE 'claude-sonnet-4-5' END
       FROM runs AS r ORDER BY r.start_s`,

      `UPDATE chat_runs SET metadata_json = json_set(metadata_json,
         '$.accounted_usage', json_object('total', 30000, 'completion', 1200, 'cache_read', 20000, 'cache_write', 900))`,
      `UPDATE chat_runs SET metadata_json = json_set(metadata_json, '$.run_policy', json_object(
           'budget_id', 'budget-' || CAST(substr(run_id, 5) AS INTEGER),
           'execution', json_object('mode', 'inline', 'observe', json('false')),
           'capabilities', json_array('read_only'), 'auto_approve', json('false'),
           'google_accounts', NULL, 'space', NULL))
       WHERE CAST(substr(run_id, 5) AS INTEGER) < ${size(9_700)}`,

      // Six messages a turn: the ask, two tool calls with their results, the
      // answer. Each Automation chat starts with three turns no run wrote, and
      // every fork starts with copies of them.
      `CREATE TEMP TABLE turns (session_id TEXT, k INTEGER, prefix TEXT, start_s INTEGER, run_idx INTEGER,
         copied_from TEXT)`,
      `INSERT INTO turns SELECT session_id, k, run_id, start_s, idx, NULL FROM runs`,
      `INSERT INTO turns SELECT ${threadId("t.n")}, k.n, ${threadId("t.n")} || '-i' || k.n, t.n * 60 + k.n, NULL, NULL
       FROM nums AS t JOIN nums AS k ON k.n < 3 WHERE t.n < ${AUTOMATIONS}`,
      `INSERT INTO turns SELECT r.session_id, k.n, 'inherited-' || r.a || '-' || k.n, r.start_s - 10, NULL,
         ${threadId("r.task")} || '-i' || k.n
       FROM runs AS r JOIN nums AS k ON k.n < 3 WHERE r.kind = 'fork'`,
      `INSERT INTO session_messages (session_id, message_id, seq, role, message_json, client_id, created_at,
         search_text)
       SELECT session_id, message_id, seq, role,
         json_patch(body, json_object('message_id', message_id, 'created_at', created_at, 'client_id', client_id,
           'forked_from', forked_from)),
         client_id, created_at, search_text
       FROM (
         SELECT t.session_id, t.k, t.start_s, m.n,
           t.prefix || ${MESSAGE_SUFFIX} AS message_id,
           CASE WHEN t.copied_from IS NOT NULL THEN t.copied_from || ${MESSAGE_SUFFIX} END AS forked_from,
           t.k * 6 + m.n AS seq,
           CASE m.n WHEN 0 THEN 'user' WHEN 2 THEN 'tool' WHEN 4 THEN 'tool' ELSE 'assistant' END AS role,
           CASE m.n
             WHEN 0 THEN json_object('role', 'user', 'content', 'Look into item ' || t.prefix, 'turn_id', t.prefix || '-u')
             WHEN 5 THEN json_object('role', 'assistant', 'content', 'Done with item ' || t.prefix || '. ' || ${text(500)},
               'turn_id', t.prefix || '-u')
             WHEN 2 THEN json_object('role', 'tool', 'tool_call_id', 'call-' || COALESCE(t.run_idx, t.prefix) || '-0',
               'content', 'Three results for item ' || t.prefix || ': ' || ${text(800)}, 'turn_id', t.prefix || '-u')
             WHEN 4 THEN json_object('role', 'tool', 'tool_call_id', 'call-' || COALESCE(t.run_idx, t.prefix) || '-1',
               'content', 'One page about item ' || t.prefix, 'turn_id', t.prefix || '-u')
             ELSE json_object('role', 'assistant', 'content', NULL, 'turn_id', t.prefix || '-u',
               'tool_calls', json_array(json_object('id', 'call-' || COALESCE(t.run_idx, t.prefix) || '-' || (m.n / 2),
                 'type', 'function', 'function', json_object('name', 'web_search', 'arguments', '{"query":"item"}'))))
           END AS body,
           CASE WHEN m.n = 0 AND t.run_idx IS NOT NULL THEN 'client-' || t.prefix END AS client_id,
           ${at("t.start_s + m.n * 5")} AS created_at,
           CASE m.n WHEN 0 THEN 'Look into item ' || t.prefix WHEN 5 THEN 'Done with item ' || t.prefix || '. ' || ${text(500)} END AS search_text
         FROM turns AS t JOIN nums AS m ON m.n < 6)
       ORDER BY start_s, session_id, k, n`,
      `INSERT INTO session_turns (session_id, turn_id, turn_index, user_message_id, message_start_id,
         message_end_id, message_start_seq, message_end_seq, started_at, ended_at)
       SELECT session_id, prefix || '-u', k, prefix || '-u', prefix || '-u', prefix || '-a2', k * 6, k * 6 + 5,
         ${at("start_s")}, ${at("start_s + 30")}
       FROM turns`,
      `UPDATE sessions SET
         active_message_count = (SELECT COUNT(*) FROM session_messages AS m WHERE m.session_id = sessions.session_id),
         visible_message_count = (SELECT COUNT(*) FROM session_messages AS m
           WHERE m.session_id = sessions.session_id AND m.search_text IS NOT NULL),
         last_activity = COALESCE((SELECT MAX(created_at) FROM session_messages AS m
           WHERE m.session_id = sessions.session_id), last_activity)
       WHERE session_id IN (SELECT session_id FROM turns)`,

      // About ten and a half tool calls a run; one run in forty used the browser.
      `INSERT INTO tool_calls (run_id, session_id, tool_call_id, tool_name, arguments_json, changes_state,
         status, result_json, started_at, ended_at, effect)
       SELECT r.run_id, r.session_id, 'call-' || r.idx || '-' || c.n,
         CASE
           WHEN c.n = 0 AND r.idx < ${AGENTS * 8} AND r.idx % 8 = 0 AND r.kind = 'user' THEN 'spawn_agent'
           WHEN c.n = 0 THEN 'web_search'
           WHEN r.idx % 40 = 0 THEN CASE c.n % 3 WHEN 0 THEN 'browser_open' WHEN 1 THEN 'browser_snapshot' ELSE 'browser_act' END
           ELSE CASE (r.idx + c.n) % 7 WHEN 0 THEN 'read_file' WHEN 1 THEN 'shell' WHEN 2 THEN 'memory_search'
             WHEN 3 THEN 'web_fetch' WHEN 4 THEN 'space_task_update' WHEN 5 THEN 'report' ELSE 'web_search' END
         END,
         '{"query":"item"}', CASE WHEN (r.idx + c.n) % 7 = 1 THEN 1 ELSE 0 END, 'completed',
         json_object('is_error', json('false'), 'content', ${text(600)}), ${at("r.start_s + 5 + c.n")}, ${at("r.start_s + 6 + c.n")},
         CASE WHEN (r.idx + c.n) % 7 = 1 THEN 'local_files' ELSE 'none' END
       FROM runs AS r JOIN nums AS c ON c.n < 1 + (r.idx * 13 + 5) % 20`,

      // The Automations' runs: forks for the newest of the three big ones,
      // a run in its own chat for the newest of the others, and older runs
      // whose fork is gone. The last three thousand were started by a chat.
      `INSERT INTO automation_runs (id, task_id, automation_ref, origin, purpose, context_mode, claim_count,
         disposition, chat_run_id, chat_session_id, started_at, ended_at, status, result, error, outcome)
       SELECT a.n + 1, ${automationId(automationTask("a.n"))}, 'ref-auto-' || ${pad(2, automationTask("a.n"))},
         json_object('kind', 'automation', 'automation_id', ${automationId(automationTask("a.n"))},
           'occurrence_id', 'occ-' || a.n),
         'user_automation', CASE WHEN a.n < ${BIG_AUTOMATION_RUNS} THEN 'fork' ELSE 'fresh' END, 1,
         CASE o.outcome WHEN 'finished' THEN 'completed' WHEN 'no_change' THEN 'no_change'
           WHEN 'needs_you' THEN 'needs_you' ELSE 'failed' END,
         COALESCE(r.run_id, 'run-gone-' || a.n),
         COALESCE(r.session_id, CASE WHEN a.n < ${BIG_AUTOMATION_RUNS}
           THEN ${threadId(automationTask("a.n"))} || '::f' || (a.n + 1) ELSE ${threadId(automationTask("a.n"))} END),
         ${at(automationStart("a.n"))}, ${at(`${automationStart("a.n")} + 130`)},
         CASE o.outcome WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled'
           WHEN 'interrupted' THEN 'interrupted' ELSE 'completed' END,
         CASE WHEN o.outcome IN ('finished', 'no_change', 'needs_you') THEN 'Checked. ' || ${text(1200)} END,
         CASE WHEN o.outcome = 'failed' THEN 'The model provider did not answer.' END,
         o.outcome
       FROM nums AS a
       JOIN (SELECT n, ${outcome("n")} AS outcome FROM nums WHERE n < ${TASK_AUTOMATION_RUNS}) AS o ON o.n = a.n
       LEFT JOIN runs AS r ON r.a = a.n
       WHERE a.n < ${TASK_AUTOMATION_RUNS}`,
      `INSERT INTO automation_runs (id, task_id, automation_ref, origin, purpose, context_mode, claim_count,
         chat_run_id, chat_session_id, started_at, ended_at, status, error, outcome, disposition)
       SELECT a.n + 1, NULL, NULL,
         json_object('kind', 'chat', 'session_id', r.session_id, 'turn_id', r.run_id || '-u'),
         NULL, 'continue', 0, r.run_id, r.session_id, ${at("r.start_s")}, ${at("r.start_s + 60")},
         CASE r.status WHEN 'completed' THEN 'completed' WHEN 'error' THEN 'failed' ELSE r.status END,
         CASE WHEN r.status = 'error' THEN 'The model provider did not answer.' END,
         CASE r.status WHEN 'completed' THEN 'finished' WHEN 'error' THEN 'failed' ELSE r.status END,
         CASE r.status WHEN 'completed' THEN 'completed' ELSE 'failed' END
       FROM nums AS a JOIN runs AS r ON r.idx = CASE
           WHEN a.n < ${TASK_AUTOMATION_RUNS + AGENTS} THEN ${AGENT_FROM} + a.n - ${TASK_AUTOMATION_RUNS}
           WHEN a.n < ${TASK_AUTOMATION_RUNS + AGENTS + CHANNEL_RUNS}
             THEN ${CHANNEL_FROM} + a.n - ${TASK_AUTOMATION_RUNS + AGENTS}
           ELSE (a.n - ${TASK_AUTOMATION_RUNS + AGENTS + CHANNEL_RUNS}) * 15 END
       WHERE a.n >= ${TASK_AUTOMATION_RUNS} AND a.n < ${AUTOMATION_RUNS}`,

      // The reviewer of space-00, with its runs over the whole history; the
      // Space page counts today's. Off, so the timer jobs leave it alone.
      `INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, triggers, enabled, created_at,
         purpose, owner_space_id, context_mode)
       VALUES ('space:space-00', 'ref-space-00', 'Space review', 'Review the Space.', '[]', 0, ${at("0")},
         'space_review', 'space-00', 'fresh')`,
      `INSERT INTO automation_runs (id, task_id, automation_ref, origin, purpose, context_mode, claim_count,
         started_at, ended_at, status, outcome, disposition)
       SELECT ${AUTOMATION_RUNS} + 1 + n, 'space:space-00', 'ref-space-00',
         json_object('kind', 'automation', 'automation_id', 'space:space-00', 'occurrence_id', 'review-' || n),
         'space_review', 'fresh', 1, ${at(`n * ${span} / ${SPACE_REVIEWS}`)},
         ${at(`n * ${span} / ${SPACE_REVIEWS} + 90`)}, 'completed',
         CASE WHEN n % 5 = 0 THEN 'no_change' ELSE 'finished' END,
         CASE WHEN n % 5 = 0 THEN 'no_change' ELSE 'completed' END
       FROM nums WHERE n < ${SPACE_REVIEWS}`,

      // How each Automation run, agent run and some chat runs ended.
      `INSERT INTO run_endings (run_id, purpose, status, detail, text, place, place_kind, occurred_at,
         shown, decided)
       SELECT r.run_id,
         CASE WHEN r.kind IN ('fork', 'thread') THEN 'user_automation' ELSE 'chat' END,
         CASE WHEN r.status = 'error' THEN 'failed' WHEN r.status = 'interrupted' THEN 'failed'
           WHEN r.status = 'cancelled' THEN 'cancelled' WHEN r.outcome = 'no_change' THEN 'silent'
           WHEN r.outcome = 'needs_you' THEN 'waiting' ELSE 'finished' END,
         NULL, CASE WHEN r.status = 'error' THEN 'The model provider did not answer.' ELSE 'Checked; nothing new.' END,
         CASE WHEN r.kind = 'fork' THEN ${threadId("r.task")} WHEN r.kind = 'agent' THEN p.session_id ELSE r.session_id END,
         CASE WHEN r.kind = 'fork' THEN 'chat' WHEN r.kind = 'agent' THEN 'parent' ELSE 'own' END,
         ${at("r.start_s + 40 + r.idx % 90")}, 1, 1
       FROM runs AS r LEFT JOIN runs AS p ON p.idx = r.parent_idx
       WHERE r.kind IN ('fork', 'thread', 'agent') OR (r.kind = 'user' AND r.idx % 14 = 0)`,

      // Reports the Automations delivered to their chat.
      `INSERT INTO automation_deliveries (delivery_id, task_id, delivered_at, subject, body, payload, status,
         created_at, destinations)
       SELECT printf('%064x', r.idx), ${automationId("r.task")}, ${at("r.start_s + 200")},
         'Report ' || r.a, ${text(1500)},
         json_object('kind', 'result', 'sessionId', r.session_id,
           'context', json_object('origin', json_object('kind', 'automation',
             'automation_id', ${automationId("r.task")}, 'occurrence_id', 'occ-' || r.a), 'task', NULL),
           'runIds', json_array(r.run_id), 'questionId', NULL),
         'delivered', ${at("r.start_s + 190")}, json_array('chat:' || ${threadId("r.task")})
       FROM runs AS r WHERE r.kind = 'fork' AND r.status = 'completed'
       ORDER BY r.idx DESC LIMIT ${size(2_500)}`,

      // Model calls: six and a half a run.
      `INSERT INTO run_model_usage (run_id, sample_id, usage_json, admitted_at, responded_at)
       SELECT r.run_id, 's' || u.n,
         json_object('prompt', 4000 + u.n * 300, 'completion', 200 + r.idx % 300, 'total', 4200 + u.n * 300 + r.idx % 300,
           'cache_read', 3000, 'cache_write', 100),
         ${at("r.start_s + u.n * 4")}, ${at("r.start_s + u.n * 4 + 3")}
       FROM runs AS r JOIN nums AS u ON u.n < 1 + r.idx * 5 % 12`,

      // Questions runs asked: most answered or closed long ago, a few open now.
      `CREATE TEMP TABLE questions AS
       SELECT 'question-' || r.idx AS question_id, r.run_id, r.session_id, 'call-' || r.idx || '-0' AS tool_call_id,
         r.start_s + 20 AS asked_s, CASE WHEN r.idx % 200 = 3 THEN 'closed' ELSE 'answered' END AS fate
       FROM runs AS r WHERE r.kind = 'user' AND r.idx % 20 = 3 AND r.status = 'completed'
       ORDER BY r.idx LIMIT ${QUESTIONS}`,
      `INSERT INTO questions
       SELECT 'question-' || r.idx, r.run_id, r.session_id, 'call-' || r.idx || '-0', r.start_s + 20, 'open'
       FROM runs AS r WHERE r.kind IN ('fork', 'thread') AND r.outcome = 'needs_you'
       ORDER BY r.start_s DESC LIMIT ${OPEN_QUESTIONS}`,
      `INSERT INTO run_questions (question_id, run_id, tool_call_id, content, created_at)
       SELECT question_id, run_id, tool_call_id,
         json_object('prompt', 'Which of these should I follow up on?', 'detail', NULL, 'choices', json_array(
           json_object('id', 'first', 'label', 'The first'), json_object('id', 'second', 'label', 'The second'))),
         ${at("asked_s")}
       FROM questions ORDER BY asked_s`,
      `UPDATE run_questions SET resolution = json_object('client_id', 'answer-' || question_id,
           'answer', json_object('kind', 'text', 'text', 'The first one'),
           'resolved_at', strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at, '+10 minutes')))
       WHERE question_id IN (SELECT question_id FROM questions WHERE fate = 'answered')`,
      `UPDATE run_questions SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at, '+1 day'))
       WHERE question_id IN (SELECT question_id FROM questions WHERE fate = 'closed')`,

      // The event journal: seven events a run, in the order they happened.
      `CREATE TEMP TABLE journal_rows AS
       SELECT r.session_id AS stream_id, (r.k - r.first_k) * 7 + e.n + 1 AS sequence,
         CASE e.n WHEN 0 THEN 'RUN_STARTED' WHEN 1 THEN 'TEXT_MESSAGE_START' WHEN 2 THEN 'TEXT_MESSAGE_CONTENT'
           WHEN 3 THEN 'TEXT_MESSAGE_END' WHEN 4 THEN 'TOOL_CALL_START' WHEN 5 THEN 'TOOL_CALL_END'
           ELSE 'RUN_FINISHED' END AS event_type,
         CASE e.n
           WHEN 0 THEN json_object('type', 'RUN_STARTED', 'run_id', r.run_id, 'session_id', r.session_id,
             'turn_id', r.run_id || '-u')
           WHEN 1 THEN json_object('type', 'TEXT_MESSAGE_START', 'message_id', r.run_id || '-a2')
           WHEN 2 THEN json_object('type', 'TEXT_MESSAGE_CONTENT', 'message_id', r.run_id || '-a2',
             'delta', 'Done with item ' || r.run_id || '. ' || ${text(300)})
           WHEN 3 THEN json_object('type', 'TEXT_MESSAGE_END', 'message_id', r.run_id || '-a2')
           WHEN 4 THEN json_object('type', 'TOOL_CALL_START', 'tool_call_id', 'call-' || r.idx || '-0',
             'tool_call_name', 'web_search')
           WHEN 5 THEN json_object('type', 'TOOL_CALL_END', 'tool_call_id', 'call-' || r.idx || '-0')
           ELSE json_object('type', 'RUN_FINISHED', 'run_id', r.run_id, 'turn_id', r.run_id || '-u') END AS data_json,
         json_object('runId', r.run_id) AS attributes_json,
         r.start_s + e.n * 5 AS at_s
       FROM runs AS r JOIN nums AS e ON e.n < 7`,
      // The lifecycle stream every screen follows: a change for each
      // Automation run, and one for each question asked and each one settled.
      `CREATE TEMP TABLE lifecycle_rows AS
       SELECT 'entity_changed' AS event_type,
         json_object('type', 'entity_changed', 'kind', 'automation', 'id', ${automationId(automationTask("n"))}) AS data_json,
         ${automationStart("n")} + 150 AS at_s
       FROM nums WHERE n < ${TASK_AUTOMATION_RUNS}
       UNION ALL
       SELECT 'question_changed', json_object('type', 'question_changed', 'session_id', q.session_id,
           'question_id', q.question_id, 'run_id', q.run_id, 'item_id', NULL), q.asked_s + e.n * 600
       FROM questions AS q JOIN nums AS e ON e.n < CASE WHEN q.fate = 'open' THEN 1 ELSE 2 END`,
      `INSERT INTO journal_rows (stream_id, sequence, event_type, data_json, attributes_json, at_s)
       SELECT 'automation:events',
         (SELECT head_sequence FROM journal_streams WHERE stream_id = 'automation:events')
           + ROW_NUMBER() OVER (ORDER BY at_s, event_type, data_json),
         event_type, data_json, '{}', at_s
       FROM lifecycle_rows`,
      `DROP TABLE lifecycle_rows`,
      `INSERT INTO journal_streams (stream_id, head_sequence, retained_from_sequence)
       SELECT stream_id, MAX(sequence), 1 FROM journal_rows WHERE true GROUP BY stream_id
       ON CONFLICT(stream_id) DO UPDATE SET head_sequence = excluded.head_sequence`,
      // The trigger listener has read the whole lifecycle stream.
      `INSERT OR REPLACE INTO automation_trigger_cursor (stream_id, after_sequence)
       SELECT stream_id, head_sequence FROM journal_streams WHERE stream_id = 'automation:events'`,
      `INSERT INTO journal_records (stream_id, sequence, event_type, data_json, attributes_json, created_at)
       SELECT stream_id, sequence, event_type, data_json, attributes_json, ${at("at_s")}
       FROM journal_rows ORDER BY at_s, stream_id, sequence`,
      `INSERT INTO session_event_checkpoints (session_id, checkpoint_seq)
       SELECT stream_id, head_sequence FROM journal_streams WHERE stream_id IN (SELECT session_id FROM sessions)`,
      // The weekly status trim has already walked everything older than a week.
      `INSERT OR REPLACE INTO journal_retention_cursors (name, after_rowid, stream_id, sequence)
       SELECT 'lifecycle_status', rowid, stream_id, sequence FROM journal_records
       WHERE rowid = (SELECT MAX(rowid) FROM journal_records
         WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', ${end} - 8 * 86400, 'unixepoch'))`,

      `INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner, runs_in, created_at,
         updated_at, completed_at, created_by)
       SELECT 'item-' || ${pad(5, "n")}, 'space-' || ${pad(2, `n % ${SPACES - 2}`)}, 'task-' || n,
         'Follow up on item ' || n,
         CASE WHEN n >= ${SPACE_TASKS - OPEN_TASKS} THEN 'open' WHEN n % 10 < 9 THEN 'done' ELSE 'cancelled' END,
         CASE WHEN n % 3 = 0 THEN 'user' ELSE 'worker' END, 'background',
         ${at(`n * ${span} / ${SPACE_TASKS}`)}, ${at(`n * ${span} / ${SPACE_TASKS} + 3600`)},
         CASE WHEN n < ${SPACE_TASKS - OPEN_TASKS} THEN ${at(`n * ${span} / ${SPACE_TASKS} + 3600`)} END, 'owner'
       FROM nums WHERE n < ${SPACE_TASKS}`,
      `INSERT INTO space_task_events (space_id, item_id, event_type, summary, created_at)
       SELECT t.space_id, t.item_id,
         CASE e.n % 5 WHEN 0 THEN 'created' WHEN 1 THEN 'updated' WHEN 2 THEN 'scheduled'
           WHEN 3 THEN 'comment' ELSE CASE WHEN t.status = 'done' THEN 'done' ELSE 'updated' END END,
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
       SELECT 'budget-' || idx, 0, 20000 + idx % 5000, session_id FROM runs WHERE idx < ${size(9_700)}`,
      `INSERT INTO run_sidecars (run_id, session_id, updated_at)
       SELECT run_id, session_id, ${at("start_s + 60")} FROM runs WHERE kind <> 'user' LIMIT ${size(5_100)}`,
      `INSERT INTO tool_call_targets (run_id, tool_call_id, source, object_id, at, title, href)
       SELECT run_id, tool_call_id, 'web', 'https://example.com/' || rowid, started_at, 'Page ' || rowid,
         'https://example.com/' || rowid
       FROM tool_calls WHERE tool_name = 'web_fetch' LIMIT ${size(4_900)}`,
      `INSERT INTO approval_reviews (run_id, tool_call_id, session_id, tool_name, reviewed_at, rung, decision,
         decided_by, verdict, risk, user_authorization, authorization_source, policy_category)
       SELECT run_id, tool_call_id, session_id, tool_name, started_at, 'default', 'allow', 'outcome', 'allow',
         'low', 'high', 'owner', 'none'
       FROM tool_calls WHERE changes_state = 1 LIMIT ${size(4_200)}`,
      `INSERT INTO letter_subjects (session_id, message_id, subject)
       SELECT session_id, run_id || '-a2', 'Report on ' || run_id FROM runs
       WHERE kind IN ('fork', 'thread', 'user') ORDER BY idx DESC LIMIT ${size(7_000)}`,
      `INSERT INTO home_presence (client_id, sequence, last_seen_at, lease_until)
       SELECT 'device-' || n, n, ${at(`n * ${span} / ${size(2_400)}`)}, ${at(`n * ${span} / ${size(2_400)} + 60`)}
       FROM nums WHERE n < ${size(2_400)}`,
      // Browser procedure learning is on, so its job looks at every run that used the browser.
      `INSERT INTO browser_procedure_settings (singleton, enabled, since)
       VALUES (1, 1, ${at("0")})
       ON CONFLICT(singleton) DO UPDATE SET enabled = 1, since = excluded.since`,
      // The hourly trim keeps only the answer of a fork nobody used for a
      // week; on an old database every older fork is trimmed already.
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
      // An old database has finished every backfill; the rows above are already in their final form.
      `INSERT OR REPLACE INTO data_backfills (name, converted, started_at, updated_at, finished_at)
       SELECT value, 0, ${at("0")}, ${at("0")}, ${at("0")}
       FROM json_each('${JSON.stringify(backfills.map((backfill) => backfill.name))}')`,
      `DROP TABLE journal_rows`,
      `DROP TABLE questions`,
      `DROP TABLE turns`,
      `DROP TABLE runs`,
      `DROP TABLE nums`
    ]
    for (const step of steps) {
      try {
        database.exec(step)
      } catch (cause) {
        throw new Error(`Seeding failed at: ${step.slice(0, 300)}`, { cause })
      }
    }
    const broken = database.prepare("PRAGMA foreign_key_check").all()
    if (broken.length > 0)
      throw new Error(`Seeded rows break foreign keys: ${JSON.stringify(broken.slice(0, 5))}`)
    // No ANALYZE: Arden never runs it, so the planner works without statistics
    // here as it does on the owner's database.
    database.exec("COMMIT")
    // The search index of an old database holds every message; the change
    // list behind it is empty.
    database.prepare("ATTACH DATABASE ? AS search").run(join(dirname(filename), "search.sqlite"))
    database.exec("BEGIN IMMEDIATE")
    database.exec(`INSERT INTO search.session_messages_fts (rowid, search_text)
      SELECT message_rowid, search_text FROM main.session_messages WHERE search_text IS NOT NULL`)
    database.exec(`UPDATE search.transcript_cursor
      SET applied_sequence = (SELECT head_sequence FROM main.transcript_search_clock WHERE singleton_id = 1)`)
    database.exec("DELETE FROM main.transcript_search_changes")
    database.exec("COMMIT")
  } catch (cause) {
    if (database.isTransaction) database.exec("ROLLBACK")
    throw cause
  } finally {
    database.close()
  }
  return {
    chat: "chat-0001",
    chatRun: `run-${String(USER_CHATS * 30 + 1).padStart(5, "0")}`,
    chatTurn: `run-${String(USER_CHATS * 30 + 1).padStart(5, "0")}-u`,
    chatToolCall: `call-${USER_CHATS * 30 + 1}-0`,
    thread: "thread-00",
    fork: `thread-00::f${BIG_AUTOMATION_RUNS - 3 + 1}`,
    forkRun: `run-${String(FORK_FROM + FORK_RUNS - 3).padStart(5, "0")}`,
    agent: "agent-0000",
    agentRun: `run-${String(AGENT_FROM).padStart(5, "0")}`,
    channel: "channel-001",
    space: "space-00",
    busyAutomation: "auto-00",
    freshAutomation: "auto-03",
    taskItem: `item-${String(SPACE_TASKS - 1).padStart(5, "0")}`
  }
}
