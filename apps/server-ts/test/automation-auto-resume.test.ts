import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { automationRulesLayer } from "../src/automations/rules.js"
import { AutomationRules } from "../src/persistence/automations/model.js"
import { resumeDueAutomations } from "../src/persistence/sqlite/automation-resume.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const NOW = "2026-11-07T10:00:00.000Z"
const EARLIER = "2026-11-07T09:00:00.000Z"
const LATER = "2026-11-07T16:00:00.000Z"
const DAILY = JSON.stringify([{ type: "time", at: "09:30", days: "daily", id: "t1" }])

const automation = (id: string, triggers: string, resumeAt: string | null) =>
  `INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, triggers, created_at,
      thread_id, enabled, paused_at, auto_resume_at, auto_resumes)
    VALUES ('${id}', 'ref-${id}', '${id}', 'Check.', '${triggers}', '${EARLIER}', 'thread', 0,
      '${EARLIER}', ${resumeAt === null ? "NULL" : `'${resumeAt}'`}, 1)`

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
      yield* resumeDueAutomations({ sql, rules, now: NOW })
      const rows = yield* sql<{
        readonly task_id: string
        readonly enabled: number
        readonly next_run_at: string | null
        readonly auto_resume_at: string | null
        readonly auto_resumes: number
      }>`SELECT task_id, enabled, next_run_at, auto_resume_at, auto_resumes
        FROM scheduled_tasks ORDER BY task_id`
      expect(rows).toEqual([
        // Runs at once for the run it missed; the try is counted.
        {
          task_id: "due-daily",
          enabled: 1,
          next_run_at: NOW,
          auto_resume_at: null,
          auto_resumes: 2
        },
        {
          task_id: "due-listening",
          enabled: 1,
          next_run_at: null,
          auto_resume_at: null,
          auto_resumes: 2
        },
        {
          task_id: "paused-by-owner",
          enabled: 0,
          next_run_at: null,
          auto_resume_at: null,
          auto_resumes: 1
        },
        {
          task_id: "waiting",
          enabled: 0,
          next_run_at: null,
          auto_resume_at: LATER,
          auto_resumes: 1
        }
      ])
    }).pipe(Effect.provide(automationRulesLayer))
  )
})
