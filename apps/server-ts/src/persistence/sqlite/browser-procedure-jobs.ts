import { randomUUID } from "node:crypto"
import { JobLeaseLostError, type JobDriver, type JobLease } from "@arden-hq/jobs"
import type { SqlError } from "effect/unstable/sql"
import { DateTime, Effect } from "effect"
import type { ProcedureJob } from "../browser-procedures/model.js"
import type { WriterDeps } from "./deps.js"

export const makeBrowserProcedureJobs = (
  deps: WriterDeps,
  enabled: Effect.Effect<boolean, SqlError.SqlError>
): JobDriver<ProcedureJob, void> => {
  const { writer } = deps
  const { sql, reader } = writer
  const leased = <A>(id: string, token: string, body: Effect.Effect<A, unknown>) =>
    writer.transact(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly id: string
        }>`SELECT id FROM browser_procedure_jobs WHERE id=${id} AND lease_token=${token} AND status='running'`
        if (rows.length === 0) return yield* Effect.fail(new JobLeaseLostError(id))
        return yield* body
      })
    )
  return {
    recoverExpired: (at) =>
      Effect.runPromise(
        writer
          .run(
            sql`UPDATE browser_procedure_jobs SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,lease_token=NULL,lease_until=NULL,updated_at=${DateTime.formatIso(DateTime.makeUnsafe(at))} WHERE status='running' AND lease_until<=${at}`
          )
          .pipe(Effect.as(0))
      ),
    claim: (input) =>
      Effect.runPromise(
        writer.transact(
          Effect.gen(function* () {
            if (!(yield* enabled)) return []
            const rows = yield* sql<{
              readonly id: string
              readonly run_id: string
              readonly attempts: number
            }>`SELECT id,run_id,attempts FROM browser_procedure_jobs WHERE status='pending' AND attempts<3 AND (retry_at IS NULL OR retry_at<=${input.now}) ORDER BY created_at LIMIT ${input.limit}`
            const leases: Array<JobLease<ProcedureJob>> = []
            for (const row of rows) {
              const token = randomUUID()
              yield* sql`UPDATE browser_procedure_jobs SET status='running',attempts=attempts+1,lease_token=${token},lease_until=${input.now + input.leaseDurationMs},updated_at=${DateTime.formatIso(DateTime.makeUnsafe(input.now))} WHERE id=${row.id}`
              leases.push({
                id: row.id,
                token,
                attempt: row.attempts + 1,
                payload: { id: row.id, runId: row.run_id, attempts: row.attempts + 1 },
                leasedAt: input.now,
                expiresAt: input.now + input.leaseDurationMs
              })
            }
            return leases
          })
        )
      ),
    renew: (input) =>
      Effect.runPromise(
        leased(
          input.id,
          input.token,
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly run_id: string
              readonly attempts: number
            }>`SELECT run_id,attempts FROM browser_procedure_jobs WHERE id=${input.id}`
            const row = rows[0]
            if (row === undefined) return yield* Effect.fail(new JobLeaseLostError(input.id))
            yield* sql`UPDATE browser_procedure_jobs SET lease_until=${input.now + input.leaseDurationMs} WHERE id=${input.id}`
            return {
              id: input.id,
              token: input.token,
              attempt: row.attempts,
              payload: { id: input.id, runId: row.run_id, attempts: row.attempts },
              leasedAt: input.now,
              expiresAt: input.now + input.leaseDurationMs
            }
          })
        )
      ),
    complete: (input) =>
      Effect.runPromise(
        leased(
          input.id,
          input.token,
          sql`UPDATE browser_procedure_jobs SET status='completed',lease_token=NULL,lease_until=NULL,error=NULL,updated_at=${DateTime.formatIso(DateTime.makeUnsafe(input.completedAt))} WHERE id=${input.id}`
        ).pipe(Effect.asVoid)
      ),
    fail: (input) =>
      Effect.runPromise(
        leased(
          input.id,
          input.token,
          sql`UPDATE browser_procedure_jobs SET status=${input.retryAt === null ? "failed" : "pending"},retry_at=${input.retryAt},error=${input.error},lease_token=NULL,lease_until=NULL,updated_at=${DateTime.formatIso(DateTime.makeUnsafe(input.failedAt))} WHERE id=${input.id}`
        ).pipe(Effect.asVoid)
      ),
    release: (input) =>
      Effect.runPromise(
        leased(
          input.id,
          input.token,
          sql`UPDATE browser_procedure_jobs SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,lease_token=NULL,lease_until=NULL,updated_at=${DateTime.formatIso(DateTime.makeUnsafe(input.releasedAt))} WHERE id=${input.id}`
        ).pipe(Effect.asVoid)
      ),
    nextDueAt: (at) =>
      Effect.runPromise(
        reader<{
          readonly at: number | null
        }>`SELECT MIN(retry_at) at FROM browser_procedure_jobs WHERE status='pending' AND retry_at>${at}`.pipe(
          Effect.map((rows) => rows[0]?.at ?? undefined)
        )
      )
  }
}
