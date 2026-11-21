import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ApprovalPolicyStore } from "../src/persistence/permissions/approval-policy.js"
import { taskJobId } from "../src/persistence/space-job-id.js"
import { storedAuthority } from "../src/persistence/sqlite/run-authority.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { startJob } from "./fixtures/job-runs.js"
import { claim, makeTask } from "./work-fixtures.js"

const OWNER_CHAT = "owner-chat"

type Kind = "space" | "loose"

const makeLooseTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO sessions (session_id, public_ref, name, started_at, last_activity)
    VALUES (${OWNER_CHAT}, 'chat~owner', 'Owner', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
  return yield* (yield* WorkStore).create(
    { kind: "chat", sessionId: OWNER_CHAT },
    { text: "Loose work", runs_in: "background" }
  )
})

const poison = (itemId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
      VALUES ('space-other', 'Other', 'other', '{"enabled":true}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
    yield* sql`INSERT INTO scheduled_tasks (task_id, automation_ref, name, description, prompt, context_mode,
        triggers, enabled, created_at, auto_approve, builtin, tool_scope, triggers_source, purpose,
        owner_space_id, owner_task_id)
      VALUES (${taskJobId(itemId)}, 'internal-job~stale-task', 'Stale', 'Internal Space execution', 'Work.',
        'fresh', '[]', 1, '2026-11-01T00:00:00.000Z', 1, 1, 'all', 'space_runtime', 'task_execution',
        'space-other', ${itemId})`
  })

const tried = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({
        refused: String((error as { message?: unknown }).message ?? error)
      }),
      onSuccess: (value) => value
    })
  )

const permissionCase = (kind: Kind, poisoned: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const policy = yield* ApprovalPolicyStore
    const task = kind === "space" ? yield* makeTask : yield* makeLooseTask
    if (poisoned) yield* poison(task.item_id)
    const key = taskJobId(task.item_id)
    const lease = (yield* claim("worker", 10)).find((entry) => entry.payload.automationId === key)
    if (lease === undefined) throw new Error("The Task worker was not claimed")
    const started = yield* startJob(lease, "worker-1")
    const [stored] = yield* sql<{ readonly authority_json: string | null }>`
      SELECT authority_json FROM chat_runs WHERE run_id = ${started.run.runId}`
    const authority = storedAuthority(stored?.authority_json ?? null)
    if (authority === undefined) throw new Error("The worker run has no authority")
    const read = () =>
      Effect.gen(function* () {
        const live = yield* tried(policy.live({ runId: started.run.runId, authority }))
        return {
          session: yield* tried(policy.session(started.sessionId)),
          live:
            "refused" in live
              ? live
              : { state: live.state, mode: live.mode, currentScope: live.currentScope }
        }
      })
    const atDefault = yield* read()
    yield* policy.setDefaultMode("allow")
    const atAllow = yield* read()
    const setByHand = yield* tried(
      policy.setSession({ sessionId: started.sessionId, mode: "allow" })
    )
    const [current] = yield* sql<{ readonly updated_at: string }>`
      SELECT updated_at FROM space_tasks WHERE item_id = ${task.item_id}`
    yield* (yield* WorkStore).update(
      { kind: "item", itemId: task.item_id },
      current?.updated_at ?? "",
      {
        status: "done"
      }
    )
    const afterDone = yield* tried(policy.live({ runId: started.run.runId, authority }))
    return {
      afterDone: "refused" in afterDone ? afterDone : afterDone.state,
      follows: authority.approval.follows,
      actor: authority.actor.kind,
      defaultMode: "safe",
      atDefault,
      atAllow,
      setByHand: "refused" in setByHand ? "refused" : "changed",
      key
    }
  })

const expected = (kind: Kind, key: string) => {
  const inSpace = kind === "space"
  const session = (mode: string) => ({
    kind: "automation",
    automation_id: key,
    tool_scope: "space",
    auto_approve: inSpace,
    ...(inSpace ? { approval_mode: mode } : {})
  })
  return {
    afterDone: "revoked",
    follows: inSpace
      ? { kind: "space_thread", space_id: "space-1" }
      : { kind: "automation", automation_id: key },
    actor: "task_worker",
    defaultMode: "safe",
    atDefault: {
      session: session("safe"),
      live: { state: "active", mode: inSpace ? "safe" : "ask", currentScope: "space" }
    },
    atAllow: {
      session: session("allow"),
      live: { state: "active", mode: inSpace ? "allow" : "ask", currentScope: "space" }
    },
    setByHand: "refused",
    key
  }
}

for (const kind of ["space", "loose"] as const)
  for (const poisoned of [false, true])
    it(`a ${kind} Task worker's permissions come from the Task${poisoned ? ", not a stale old row" : ""}`, async () => {
      const outcome = await withTempDatabase(permissionCase(kind, poisoned))
      expect(outcome).toEqual(expected(kind, outcome.key))
    })
