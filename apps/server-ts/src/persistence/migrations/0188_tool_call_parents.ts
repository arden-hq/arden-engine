import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const TOOL_CALL_PARENT_COLUMN = `ALTER TABLE tool_calls ADD COLUMN
      parent_tool_call_id TEXT CHECK(parent_tool_call_id IS NULL OR length(parent_tool_call_id) > 0)`

export const TOOL_CALL_NESTING_COLUMN = `ALTER TABLE tool_calls ADD COLUMN
      nesting TEXT CHECK(
        (nesting IS NULL) = (parent_tool_call_id IS NULL)
        AND (nesting IS NULL OR nesting IN ('code', 'task', 'computer', 'workflow', 'approved'))
      )`

export const TOOL_CALL_SCRIPT_COLUMN = `ALTER TABLE tool_calls ADD COLUMN
      script_tool_call_id TEXT CHECK(script_tool_call_id IS NULL OR length(script_tool_call_id) > 0)`

export const TOOL_CALL_PARENT_INDEX = `CREATE INDEX idx_tool_calls_parent
      ON tool_calls(run_id, parent_tool_call_id) WHERE parent_tool_call_id IS NOT NULL`

export const SCRIPT_AGENT_CALLS_TABLE = `CREATE TABLE script_agent_calls (
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      agent_key TEXT NOT NULL CHECK(length(agent_key) > 0),
      launch INTEGER CHECK(launch IS NULL OR launch >= 0),
      PRIMARY KEY (run_id, tool_call_id),
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`

const WORKFLOW = "workflow"
const MARKERS = [
  [":code:", "code"],
  [":task:", "task"],
  [":computer:", "computer"],
  [":workflow:", WORKFLOW]
] as const
const APPROVED = ":approved"
const SCRIPT_MARKERS = [":workflow:", ":code:"] as const
const DIGITS = /^\d+$/u

interface Lineage {
  readonly parent: string
  readonly nesting: string
}

const lineageOf = (callId: string): Lineage | undefined => {
  if (callId.endsWith(APPROVED) && callId.length > APPROVED.length)
    return { parent: callId.slice(0, -APPROVED.length), nesting: "approved" }
  const found = MARKERS.map(([marker, nesting]) => ({ at: callId.lastIndexOf(marker), nesting }))
    .filter((entry) => entry.at > 0)
    .sort((a, b) => b.at - a.at)[0]
  return found === undefined
    ? undefined
    : { parent: callId.slice(0, found.at), nesting: found.nesting }
}

const scriptOf = (callId: string): string | undefined => {
  const marks = SCRIPT_MARKERS.map((marker) => callId.indexOf(marker)).filter((at) => at > 0)
  return marks.length === 0 ? undefined : callId.slice(0, Math.min(...marks))
}

const agentOf = (
  callId: string,
  parent: string
): { readonly key: string; readonly launch: number | null } | undefined => {
  const parts = callId.slice(`${parent}:workflow:`.length).split(":")
  const key = parts.at(-3)
  if (key === undefined || key.length === 0 || !parts.slice(-2).every((part) => DIGITS.test(part)))
    return undefined
  if (parts.length === 3) return { key, launch: Number(parts[2]) }
  return parts.length === 4 && DIGITS.test(parts[0] ?? "") ? { key, launch: null } : undefined
}

const backfill = (database: DatabaseSync): void => {
  const rows = database
    .prepare(
      `SELECT run_id, tool_call_id FROM tool_calls
       WHERE tool_call_id GLOB '*:code:*' OR tool_call_id GLOB '*:task:*'
         OR tool_call_id GLOB '*:computer:*' OR tool_call_id GLOB '*:workflow:*'
         OR tool_call_id GLOB '*:approved'`
    )
    .all()
  const update = database.prepare(
    `UPDATE tool_calls SET parent_tool_call_id = ?, nesting = ?, script_tool_call_id = ?
     WHERE run_id = ? AND tool_call_id = ?`
  )
  const agent = database.prepare(
    "INSERT INTO script_agent_calls (run_id, tool_call_id, agent_key, launch) VALUES (?, ?, ?, ?)"
  )
  for (const row of rows) {
    const runId = String(row.run_id)
    const callId = String(row.tool_call_id)
    const lineage = lineageOf(callId)
    if (lineage === undefined) continue
    update.run(lineage.parent, lineage.nesting, scriptOf(callId) ?? null, runId, callId)
    const launched = lineage.nesting === WORKFLOW ? agentOf(callId, lineage.parent) : undefined
    if (launched !== undefined) agent.run(runId, callId, launched.key, launched.launch)
  }
}

export const toolCallParents: Migration = {
  version: 188,
  name: "tool_call_parents",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(TOOL_CALL_PARENT_COLUMN)
    database.exec(TOOL_CALL_NESTING_COLUMN)
    database.exec(TOOL_CALL_SCRIPT_COLUMN)
    database.exec(TOOL_CALL_PARENT_INDEX)
    database.exec(SCRIPT_AGENT_CALLS_TABLE)
    backfill(database)
  }
}
