import { Predicate } from "effect"
import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const runAuthority: Migration = {
  version: 17,
  name: "run_authority",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(
      "ALTER TABLE chat_runs ADD COLUMN authority_json TEXT CHECK(authority_json IS NULL OR (json_valid(authority_json) AND json_type(authority_json) = 'object'))"
    )
    backfill(database)
    database.exec(`CREATE TRIGGER chat_runs_immutable_authority
      BEFORE UPDATE OF authority_json ON chat_runs
      WHEN OLD.authority_json IS NOT NULL AND NEW.authority_json IS NOT OLD.authority_json
      BEGIN
        SELECT RAISE(ABORT, 'Run authority is immutable');
      END`)
  }
}

interface RunRow {
  readonly run_id: string
  readonly session_id: string
  readonly context: string | null
  readonly policy: string | null
  readonly session_type: string | null
  readonly origin_automation_id: string | null
  readonly parent_run_id: string | null
  readonly session_metadata: string | null
}

interface Automation {
  readonly purpose: string
  readonly handler: string | null
  readonly owner_desk_id: string | null
}

type Json = { readonly [key: string]: unknown }

const backfill = (database: DatabaseSync): void => {
  const automations = new Map<string, Automation>()
  for (const row of database
    .prepare("SELECT task_id, purpose, handler, owner_desk_id FROM scheduled_tasks")
    .all()) {
    const id = text(row["task_id"])
    if (id === undefined) continue
    automations.set(id, {
      purpose: text(row["purpose"]) ?? "user_automation",
      handler: text(row["handler"]) ?? null,
      owner_desk_id: text(row["owner_desk_id"]) ?? null
    })
  }
  const rows = database
    .prepare(
      `SELECT r.run_id, r.session_id,
        json_extract(r.metadata_json, '$.run_context') AS context,
        json_extract(r.metadata_json, '$.run_policy') AS policy,
        s.session_type, s.origin_automation_id, s.parent_run_id, s.metadata AS session_metadata
      FROM chat_runs r LEFT JOIN sessions s ON s.session_id = r.session_id
      WHERE r.authority_json IS NULL`
    )
    .all()
    .flatMap((row): ReadonlyArray<RunRow> => {
      const runId = text(row["run_id"])
      const sessionId = text(row["session_id"])
      if (runId === undefined || sessionId === undefined) return []
      return [
        {
          run_id: runId,
          session_id: sessionId,
          context: text(row["context"]) ?? null,
          policy: text(row["policy"]) ?? null,
          session_type: text(row["session_type"]) ?? null,
          origin_automation_id: text(row["origin_automation_id"]) ?? null,
          parent_run_id: text(row["parent_run_id"]) ?? null,
          session_metadata: text(row["session_metadata"]) ?? null
        }
      ]
    })
  const derived = new Map<string, Json>()
  const update = database.prepare("UPDATE chat_runs SET authority_json = ? WHERE run_id = ?")
  const store = (row: RunRow, authority: Json): void => {
    derived.set(row.run_id, authority)
    update.run(JSON.stringify(authority), row.run_id)
  }
  const backfilled = new Set(rows.map((row) => row.run_id))
  let agents: Array<RunRow> = []
  for (const row of rows) {
    if (row.session_type === "agent") agents.push(row)
    else store(row, rootAuthority(row, automations))
  }
  while (agents.length > 0) {
    const waiting = agents.filter(
      (row) =>
        row.parent_run_id !== null &&
        !derived.has(row.parent_run_id) &&
        backfilled.has(row.parent_run_id)
    )
    const ready = agents.filter((row) => !waiting.includes(row))
    if (ready.length === 0) {
      for (const row of waiting) store(row, unrecorded(row.session_id))
      break
    }
    for (const row of ready) store(row, agentAuthority(row, derived))
    agents = waiting
  }
}

const CAPABILITIES = new Set([
  "none",
  "read_only",
  "reports",
  "browser",
  "all",
  "desk",
  "memory_capture",
  "chat_summary",
  "agent_research",
  "agent_code"
])
const PURPOSES = new Set(["user_automation", "desk_review", "task_execution", "system"])
const AGENT_CAPABILITY: Readonly<Record<string, string>> = {
  code: "agent_code",
  research: "agent_research",
  work: "all"
}

const rootAuthority = (row: RunRow, automations: ReadonlyMap<string, Automation>): Json => {
  const context = object(parse(row.context))
  const policy = object(parse(row.policy))
  const origin = object(context?.["origin"])
  const capabilities = array(policy?.["capabilities"])?.flatMap((value) => {
    const capability = text(value)
    return capability !== undefined && CAPABILITIES.has(capability) ? [capability] : []
  })
  const execution = object(policy?.["execution"])
  const kind = text(origin?.["kind"])
  if (
    policy === undefined ||
    capabilities === undefined ||
    capabilities.length === 0 ||
    typeof execution?.["observe"] !== "boolean" ||
    kind === undefined ||
    kind === "unrecorded"
  )
    return unrecorded(row.session_id)
  const deskId = text(object(policy["desk"])?.["desk_id"]) ?? null
  const taskItemId = text(object(context?.["task"])?.["item_id"]) ?? null
  const originAutomationId = kind === "automation" ? text(origin?.["automation_id"]) : undefined
  const originAutomation =
    originAutomationId === undefined ? undefined : automations.get(originAutomationId)
  const chatAutomation =
    row.origin_automation_id === null ? undefined : automations.get(row.origin_automation_id)
  const actor = rootActor(kind, origin ?? {}, deskId, originAutomationId, originAutomation)
  if (actor === undefined) return unrecorded(row.session_id)
  const owner = permissionOwner(
    row.origin_automation_id === null || chatAutomation === undefined
      ? undefined
      : { id: row.origin_automation_id, ...chatAutomation },
    originAutomationId === undefined || originAutomation === undefined
      ? undefined
      : { id: originAutomationId, ...originAutomation }
  )
  const follows = approvalSource(
    owner,
    row.session_id,
    text(policy["authority_session_id"]) ?? row.session_id
  )
  const person = actor["kind"] === "person"
  return {
    version: 1,
    actor,
    owns: {
      session_id: row.session_id,
      desk_id: deskId,
      automation_id: person ? null : (originAutomationId ?? row.origin_automation_id),
      task_item_id: taskItemId
    },
    reach: { capabilities, observe: execution["observe"] },
    approval: { follows },
    sandbox: { kind: "host_approved" },
    memory: memoryOf(actor, deskId),
    delegation: { depth: 0, chain: [] },
    unattended: !person
  }
}

type Owner = Automation & { readonly id: string }

const permissionOwner = (chat: Owner | undefined, origin: Owner | undefined): Owner | undefined =>
  chat ?? origin

const approvalSource = (
  owner: Owner | undefined,
  sessionId: string,
  authoritySession: string
): Json => {
  if (owner === undefined) return { kind: "chat", session_id: sessionId }
  if (owner.purpose === "user_automation") return { kind: "chat", session_id: authoritySession }
  if (owner.owner_desk_id !== null) return { kind: "desk_thread", desk_id: owner.owner_desk_id }
  return { kind: "automation", automation_id: owner.id }
}

const rootActor = (
  kind: string,
  origin: Json,
  deskId: string | null,
  automationId: string | undefined,
  automation: Automation | undefined
): Json | undefined => {
  switch (kind) {
    case "chat": {
      const sessionId = text(origin["session_id"])
      const turnId = text(origin["turn_id"])
      return sessionId === undefined || turnId === undefined
        ? undefined
        : { kind: "person", session_id: sessionId, turn_id: turnId }
    }
    case "automation":
      return automationId === undefined
        ? undefined
        : {
            kind: "automation",
            automation_id: automationId,
            purpose:
              automation !== undefined && PURPOSES.has(automation.purpose)
                ? automation.purpose
                : "user_automation",
            handler: automation?.handler ?? null
          }
    case "task": {
      const itemId = text(origin["item_id"])
      return itemId === undefined
        ? undefined
        : { kind: "task_worker", item_id: itemId, desk_id: deskId }
    }
    case "desk": {
      const desk = text(origin["desk_id"])
      return desk === undefined ? undefined : { kind: "desk_review", desk_id: desk }
    }
    default:
      return undefined
  }
}

const memoryOf = (actor: Json, deskId: string | null): Json => {
  switch (actor["kind"]) {
    case "person":
      return { _tag: "Global" }
    case "automation":
      return actor["handler"] === "memory_capture" ? { _tag: "Capture" } : { _tag: "Global" }
    case "desk_review":
      return { _tag: "Desk", desk_id: actor["desk_id"] }
    case "task_worker":
      return deskId === null ? { _tag: "None" } : { _tag: "Desk", desk_id: deskId }
    default:
      return { _tag: "None" }
  }
}

const agentAuthority = (row: RunRow, derived: ReadonlyMap<string, Json>): Json => {
  const agent = object(object(parse(row.session_metadata))?.["agent"])
  const mode = text(agent?.["mode"])
  const parentRunId = row.parent_run_id
  if (mode === undefined || AGENT_CAPABILITY[mode] === undefined || parentRunId === null)
    return unrecorded(row.session_id)
  const root = text(object(agent?.["workspace"])?.["root"]) ?? null
  const parent = derived.get(parentRunId)
  const context = object(parse(row.context))
  const taskItemId = text(object(context?.["task"])?.["item_id"]) ?? null
  const reach = object(parent?.["reach"])
  if (parent === undefined || reach === undefined || reach["observe"] === true)
    return orphan(row.session_id, mode, parentRunId, root, taskItemId)
  const parentActor = object(parent["actor"]) ?? {}
  const owns = object(parent["owns"]) ?? {}
  const delegation = object(parent["delegation"]) ?? {}
  const requested = AGENT_CAPABILITY[mode]
  const inherited = (array(reach["capabilities"]) ?? []).flatMap((value) => text(value) ?? [])
  const parentSandbox = object(parent["sandbox"]) ?? { kind: "host_approved" }
  return {
    version: 1,
    actor: {
      kind: "agent",
      mode,
      parent_run_id: parentRunId,
      root: parentActor["kind"] === "agent" ? parentActor["root"] : parentActor["kind"]
    },
    owns: {
      session_id: row.session_id,
      desk_id: owns["desk_id"] ?? null,
      automation_id: owns["automation_id"] ?? null,
      task_item_id: owns["task_item_id"] ?? taskItemId
    },
    reach: {
      capabilities: [
        requested,
        ...inherited.filter(
          (capability) => capability !== requested && (requested === "all" || capability !== "all")
        )
      ],
      observe: false
    },
    approval: parent["approval"],
    sandbox:
      mode === "code" && parentSandbox["kind"] === "host_approved"
        ? { kind: "code_agent", root }
        : parentSandbox,
    memory: parent["memory"],
    delegation: {
      depth: (typeof delegation["depth"] === "number" ? delegation["depth"] : 0) + 1,
      chain: [...(array(delegation["chain"]) ?? []), parentRunId]
    },
    unattended: parent["unattended"]
  }
}

const orphan = (
  sessionId: string,
  mode: string,
  parentRunId: string,
  root: string | null,
  taskItemId: string | null
): Json => ({
  version: 1,
  actor: { kind: "agent", mode, parent_run_id: parentRunId, root: "unrecorded" },
  owns: { session_id: sessionId, desk_id: null, automation_id: null, task_item_id: taskItemId },
  reach: { capabilities: ["read_only"], observe: false },
  approval: { follows: { kind: "chat", session_id: sessionId } },
  sandbox: mode === "code" ? { kind: "code_agent", root } : { kind: "host_approved" },
  memory: { _tag: "None" },
  delegation: { depth: 1, chain: [parentRunId] },
  unattended: true
})

const unrecorded = (sessionId: string): Json => ({
  version: 1,
  actor: { kind: "unrecorded" },
  owns: { session_id: sessionId, desk_id: null, automation_id: null, task_item_id: null },
  reach: { capabilities: ["read_only"], observe: false },
  approval: { follows: { kind: "chat", session_id: sessionId } },
  sandbox: { kind: "host_approved" },
  memory: { _tag: "None" },
  delegation: { depth: 0, chain: [] },
  unattended: true
})

const parse = (value: string | null): unknown => {
  if (value === null) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const object = (value: unknown): Json | undefined =>
  Predicate.isReadonlyObject(value) && !Array.isArray(value) ? value : undefined

const array = (value: unknown): ReadonlyArray<unknown> | undefined =>
  Array.isArray(value) ? value : undefined

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined
