import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { automationRulesLayer } from "../src/automations/rules.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId, AutomationRules } from "../src/persistence/automations/model.js"
import { resumeDueAutomations } from "../src/persistence/sqlite/automation-resume.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const NOW = "2026-11-07T10:00:00.000Z"
const EARLIER = "2026-11-07T09:00:00.000Z"
const LATER = "2026-11-07T16:00:00.000Z"
const DAILY = JSON.stringify([{ type: "time", at: "09:30", days: "daily", id: "t1" }])

const automation = (
  id: string,
  triggers: string,
  resumeAt: string | null,
  options: { readonly purpose?: string; readonly enabled?: number } = {}
) =>
  `INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, triggers, created_at,
      thread_id, enabled, paused_at, auto_resume_at, auto_resumes, purpose)
    VALUES ('${id}', 'ref-${id}', '${id}', 'Check.', '${triggers}', '${EARLIER}', 'thread', ${options.enabled ?? 0},
      '${EARLIER}', ${resumeAt === null ? "NULL" : `'${resumeAt}'`}, 1, '${options.purpose ?? "user_automation"}')`

it("an Automation paused by its provider is resumed when its wait is over", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rules = yield* AutomationRules
      yield* sql.unsafe(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
        session_type) VALUES ('thread', 'ref-thread', '${EARLIER}', '${EARLIER}', 'chat')`)
      yield* sql.unsafe(automation("due-daily", DAILY, EARLIER))
      yield* sql.unsafe(automation("due-listening", "[]", EARLIER))
      yield* sql.unsafe(automation("waiting", DAILY, LATER))
      yield* sql.unsafe(automation("paused-by-owner", DAILY, null))
      yield* sql.unsafe(automation("system-due", DAILY, EARLIER, { purpose: "system" }))
      yield* sql.unsafe(automation("already-on", DAILY, EARLIER, { enabled: 1 }))
      yield* resumeDueAutomations({ sql, rules, now: NOW })
      const rows = yield* sql<{
        readonly task_id: string
        readonly enabled: number
        readonly next_run_at: string | null
        readonly auto_resume_at: string | null
        readonly auto_resumes: number
      }>`SELECT task_id, enabled, next_run_at, auto_resume_at, auto_resumes
        FROM scheduled_tasks ORDER BY task_id`
      const of = (id: string) => rows.find((row) => row.task_id === id)
      expect(of("due-daily")).toMatchObject({ enabled: 1, auto_resume_at: null, auto_resumes: 2 })
      expect(Date.parse(of("due-daily")?.next_run_at ?? "")).toBeGreaterThan(Date.parse(NOW))
      expect(of("due-listening")).toEqual({
        task_id: "due-listening",
        enabled: 1,
        next_run_at: null,
        auto_resume_at: null,
        auto_resumes: 2
      })
      expect(of("paused-by-owner")).toMatchObject({ enabled: 0, auto_resumes: 1 })
      expect(of("system-due")).toMatchObject({ enabled: 0, auto_resumes: 1 })
      expect(of("already-on")).toMatchObject({ enabled: 1, auto_resumes: 1 })
      expect(of("waiting")).toMatchObject({ enabled: 0, auto_resume_at: LATER })
      const catalog = yield* AutomationCatalog
      yield* catalog.update(AutomationId.make("waiting"), { enabled: false }, "owner")
      yield* resumeDueAutomations({ sql, rules, now: "2026-11-08T00:00:00.000Z" })
      const [kept] = yield* sql<{
        readonly enabled: number
        readonly auto_resume_at: string | null
      }>`SELECT enabled, auto_resume_at FROM scheduled_tasks WHERE task_id = 'waiting'`
      expect(kept).toEqual({ enabled: 0, auto_resume_at: null })
    }).pipe(Effect.provide(automationRulesLayer))
  )
})
