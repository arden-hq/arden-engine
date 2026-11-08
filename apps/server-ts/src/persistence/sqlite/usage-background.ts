import { countsAsRun } from "./automation-skip-record.js"
import { outcomeSql } from "./automation-run-outcome.js"
import { runAncestors } from "./tree-walk.js"
import type { UsageAutomationOutcome, UsageAutomationRow } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

interface Origin {
  readonly kind: string | null
  readonly occurrence: string | null
  readonly entity: string | null
}

interface RunRow extends Origin {
  readonly run_id: string
  readonly parent_run_id: string | null
  readonly started_at: string
  readonly accounted: number
  readonly total: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
  readonly automation_id: string | null
  readonly automation_name: string | null
  readonly available_job: string | null
  readonly available_task: string | null
  readonly task_name: string | null
  readonly task_space_id: string | null
  readonly available_space: string | null
}

interface UsageSource {
  readonly task_id: string | null
  readonly item_id: string | null
  readonly space_id: string | null
  readonly available_task: string | null
  readonly available_job: string | null
  readonly name: string
  readonly available_space: string | null
  readonly purpose: UsageAutomationRow["purpose"]
  readonly handler: string | null
  readonly outcome: UsageAutomationOutcome["outcome"]
}

interface AttemptRow extends Origin, UsageSource {
  readonly id: number
  readonly chat_run_id: string | null
  readonly started_at: string
}

const originKey = (origin: Origin): string | null =>
  origin.occurrence === null || origin.entity === null
    ? null
    : JSON.stringify([origin.kind, origin.entity, origin.occurrence])

export const backgroundUsage = Effect.fn("Usage.background")(function* (
  sql: SqlClient.SqlClient,
  since: string,
  until: string
) {
  const relevant = sql`WITH RECURSIVE ${runAncestors(sql, {
    name: "relevant",
    from: sql`SELECT run_id FROM chat_runs WHERE started_at >= ${since} AND started_at < ${until}`
  })}`
  const runs = yield* sql<RunRow>`${relevant}
    SELECT r.run_id, s.parent_run_id, r.started_at,
      json_extract(r.metadata_json, '$.run_context.origin.kind') AS kind,
      json_extract(r.metadata_json, '$.run_context.origin.occurrence_id') AS occurrence,
      coalesce(json_extract(r.metadata_json, '$.run_context.origin.automation_id'),
        json_extract(r.metadata_json, '$.run_context.origin.item_id'),
        json_extract(r.metadata_json, '$.run_context.origin.space_id')) AS entity,
      json_extract(r.metadata_json, '$.accounted_usage') IS NOT NULL AS accounted,
      coalesce(json_extract(r.metadata_json, '$.accounted_usage.total'), 0) AS total,
      coalesce(json_extract(r.metadata_json, '$.accounted_usage.completion'), 0) AS output,
      coalesce(json_extract(r.metadata_json, '$.accounted_usage.cache_read'), 0) AS cache_read,
      coalesce(json_extract(r.metadata_json, '$.accounted_usage.cache_write'), 0) AS cache_write,
      json_extract(r.metadata_json, '$.automation.task_id') AS automation_id,
      json_extract(r.metadata_json, '$.automation.name') AS automation_name,
      CASE WHEN job.purpose IN ('user_automation', 'system') THEN job.task_id END AS available_job,
      CASE WHEN (task.space_id IS NULL OR space.space_id IS NOT NULL)
        THEN task.item_id END AS available_task,
      task.text AS task_name, task.space_id AS task_space_id, space.space_id AS available_space
    FROM relevant JOIN chat_runs r ON r.run_id = relevant.run_id
    JOIN sessions s ON s.session_id = r.session_id
    LEFT JOIN scheduled_tasks job ON job.task_id = coalesce(json_extract(r.metadata_json, '$.automation.task_id'),
      json_extract(r.metadata_json, '$.run_context.origin.automation_id'))
    LEFT JOIN space_tasks task ON json_extract(r.metadata_json, '$.run_context.origin.kind') = 'task'
      AND task.item_id = json_extract(r.metadata_json, '$.run_context.origin.item_id')
    LEFT JOIN spaces space ON space.space_id = task.space_id AND space.archived_at IS NULL`
  const attempts = yield* sql<AttemptRow>`${relevant}
    SELECT a.id, a.task_id, a.item_id,
      coalesce(task.space_id, job.owner_space_id) AS space_id,
      CASE WHEN (task.space_id IS NULL OR space.space_id IS NOT NULL)
        THEN task.item_id END AS available_task,
      CASE WHEN job.purpose IN ('user_automation', 'system') THEN job.task_id END AS available_job,
      space.space_id AS available_space,
      a.chat_run_id, a.started_at, a.handler, ${outcomeSql(sql, sql`a`)} AS outcome,
      coalesce(nullif(job.name, ''), nullif(task.text, ''),
        nullif(json_extract(final.metadata_json, '$.automation.name'), ''),
        nullif(session.name, ''), 'Background work') AS name,
      coalesce(a.purpose, CASE json_extract(a.origin, '$.kind')
        WHEN 'task' THEN 'task_execution' WHEN 'space' THEN 'space_review' END) AS purpose,
      json_extract(a.origin, '$.kind') AS kind,
      json_extract(a.origin, '$.occurrence_id') AS occurrence,
      coalesce(json_extract(a.origin, '$.automation_id'), json_extract(a.origin, '$.item_id'),
        json_extract(a.origin, '$.space_id')) AS entity
    FROM automation_runs a
    LEFT JOIN scheduled_tasks job ON job.task_id = a.task_id
    LEFT JOIN space_tasks task ON task.item_id = a.item_id
    LEFT JOIN spaces space ON space.space_id = coalesce(task.space_id, job.owner_space_id) AND space.archived_at IS NULL
    LEFT JOIN chat_runs final ON final.run_id = a.chat_run_id
    LEFT JOIN sessions session ON session.session_id = a.chat_session_id
    WHERE (a.task_id IS NOT NULL OR a.item_id IS NOT NULL) AND ${countsAsRun(sql, sql`a`)} AND (
      (a.started_at >= ${since} AND a.started_at < ${until})
      OR a.chat_run_id IN (SELECT run_id FROM relevant)
      OR (a.task_id IS NOT NULL AND json_extract(a.origin, '$.occurrence_id') IN (
        SELECT json_extract(r.metadata_json, '$.run_context.origin.occurrence_id')
        FROM relevant JOIN chat_runs r ON r.run_id = relevant.run_id
      ))
    )`

  const byRun = new Map(runs.map((run) => [run.run_id, run]))
  const byOrigin = new Map<string, AttemptRow>()
  const direct = new Map<string, AttemptRow>()
  for (const attempt of attempts) {
    const key = originKey(attempt)
    if (attempt.task_id !== null && key !== null) byOrigin.set(key, attempt)
    if (attempt.chat_run_id !== null) direct.set(attempt.chat_run_id, attempt)
  }
  interface Owner {
    readonly source: UsageSource
    readonly attemptId: number | null
  }
  const owners = new Map<string, Owner | null>()
  const ownerOf = (runId: string, path = new Set<string>()): Owner | null => {
    if (owners.has(runId)) return owners.get(runId) ?? null
    if (path.has(runId)) return null
    path.add(runId)
    const run = byRun.get(runId)
    const parent =
      run?.parent_run_id === null || run?.parent_run_id === undefined
        ? null
        : ownerOf(run.parent_run_id, path)
    const key = run === undefined ? null : originKey(run)
    const attempt = (key === null ? undefined : byOrigin.get(key)) ?? direct.get(runId)
    const source = unrecordedSource(run)
    const historical = source === null ? null : { source, attemptId: null }
    const recorded = attempt === undefined ? null : { source: attempt, attemptId: attempt.id }
    const owner = parent ?? recorded ?? historical
    owners.set(runId, owner)
    return owner
  }
  const inWindow = (at: string) => at >= since && at < until
  type MutableOutcome = { -readonly [K in keyof UsageAutomationOutcome]: UsageAutomationOutcome[K] }
  interface Group {
    readonly attempt: UsageSource
    readonly outcomes: Map<string, MutableOutcome>
  }
  const groups = new Map<string, Group>()
  const outcomeFor = (attempt: UsageSource): MutableOutcome => {
    const groupKey = JSON.stringify([
      attempt.task_id,
      attempt.item_id,
      attempt.space_id,
      attempt.purpose,
      attempt.handler
    ])
    let group = groups.get(groupKey)
    if (group === undefined) {
      group = { attempt, outcomes: new Map() }
      groups.set(groupKey, group)
    }
    const key = attempt.outcome ?? "unrecorded"
    let outcome = group.outcomes.get(key)
    if (outcome === undefined) {
      outcome = {
        outcome: attempt.outcome,
        checks: 0,
        runs: 0,
        unaccounted_runs: 0,
        total: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0
      }
      group.outcomes.set(key, outcome)
    }
    return outcome
  }
  for (const attempt of attempts) {
    if (!inWindow(attempt.started_at)) continue
    const owner = attempt.chat_run_id === null ? null : ownerOf(attempt.chat_run_id)
    if (owner !== null && owner.attemptId !== attempt.id) continue
    outcomeFor(attempt).checks++
  }
  for (const run of runs) {
    if (!inWindow(run.started_at)) continue
    const owner = ownerOf(run.run_id)
    const source = owner?.source ?? null
    if (source === null) continue
    const outcome = outcomeFor(source)
    if (!run.accounted) {
      outcome.unaccounted_runs++
      continue
    }
    outcome.runs++
    outcome.total += run.total
    outcome.output += run.output
    outcome.cache_read += run.cache_read
    outcome.cache_write += run.cache_write
  }
  return [...groups.values()]
    .map(({ attempt, outcomes }): UsageAutomationRow => {
      const values = [...outcomes.values()]
      let destination: UsageAutomationRow["destination"] = null
      if (attempt.available_task !== null)
        destination = { kind: "task", item_id: attempt.available_task }
      else if (attempt.purpose === "space_review" && attempt.available_space !== null)
        destination = { kind: "space", space_id: attempt.available_space }
      else if (attempt.item_id === null && attempt.available_job !== null)
        destination = { kind: "automation", task_id: attempt.available_job }
      return {
        task_id: attempt.task_id,
        item_id: attempt.item_id,
        space_id: attempt.space_id,
        name: attempt.name,
        purpose: attempt.purpose,
        handler: attempt.handler,
        destination,
        checks: values.reduce((sum, outcome) => sum + outcome.checks, 0),
        runs: values.reduce((sum, outcome) => sum + outcome.runs, 0),
        unaccounted_runs: values.reduce((sum, outcome) => sum + outcome.unaccounted_runs, 0),
        total: values.reduce((sum, outcome) => sum + outcome.total, 0),
        cache_read: values.reduce((sum, outcome) => sum + outcome.cache_read, 0),
        outcomes: values.sort((a, b) => b.total - a.total || b.checks - a.checks)
      }
    })
    .sort((a, b) => b.total - a.total || b.checks - a.checks || a.name.localeCompare(b.name))
})

const unrecordedSource = (run: RunRow | undefined): UsageSource | null => {
  if (run === undefined) return null
  if (run.kind === "task" && run.entity !== null)
    return {
      task_id: null,
      item_id: run.entity,
      space_id: run.task_space_id,
      name: run.task_name?.trim() || "Task work",
      purpose: "task_execution",
      handler: null,
      outcome: null,
      available_task: run.available_task,
      available_space: run.available_space,
      available_job: null
    }
  const automationId = run.automation_id ?? (run.kind === "automation" ? run.entity : null)
  return automationId === null
    ? null
    : {
        task_id: automationId,
        name: run.automation_name?.trim() || "Background work",
        item_id: null,
        space_id: null,
        available_task: null,
        available_job: run.available_job,
        available_space: null,
        purpose: null,
        handler: null,
        outcome: null
      }
}
