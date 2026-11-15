import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AutomationId } from "../../src/persistence/automations/model.js"
import { AutomationQueue } from "../../src/persistence/automations/queue.js"
import { ChatWriteStore, type TaskStepCause } from "../../src/persistence/chat/store.js"

const message = (id: string, isMeta: boolean) => ({
  message_id: id,
  client_id: id,
  role: "user" as const,
  content: "Made-up words",
  created_at: new Date().toISOString(),
  ...(isMeta ? { is_meta: true } : {})
})

export const startChat = (
  sessionId: string,
  id: string,
  options: {
    readonly isMeta?: boolean
    readonly continuesTask?: TaskStepCause
    readonly automation?: {
      readonly automationId: string
      readonly attemptId: number
      readonly lease: { readonly id: string; readonly token: string }
    }
  } = {}
) =>
  Effect.gen(function* () {
    const chat = yield* ChatWriteStore
    const started = yield* chat.start({
      sessionId,
      clientId: id,
      requestHash: `${id}-hash`,
      assistantMessageId: `${id}-answer`,
      message: {
        ...message(id, options.isMeta ?? false),
        ...(options.automation === undefined
          ? {}
          : {
              content: "Made-up prompt",
              automation: {
                task_id: options.automation.automationId,
                name: "Made-up job",
                prompt: "Made-up prompt",
                context_mode: "fresh" as const
              }
            })
      },
      ...(options.continuesTask === undefined ? {} : { continuesTask: options.continuesTask }),
      ...(options.automation === undefined
        ? {}
        : {
            automation: {
              automationId: AutomationId.make(options.automation.automationId),
              attemptId: options.automation.attemptId,
              name: "Made-up job"
            },
            automationLease: options.automation.lease,
            automationPrompt: "Made-up prompt",
            automationContextMode: "fresh" as const
          })
    })
    if (started._tag !== "Started") throw new Error(`Run ${id} did not start: ${started._tag}`)
    return started
  })

export const finishChat = (started: Effect.Success<ReturnType<typeof startChat>>, id: string) =>
  Effect.gen(function* () {
    const chat = yield* ChatWriteStore
    yield* chat.finish({
      runId: started.runId,
      messages: [
        ...started.activeMessages,
        {
          message_id: `${id}-answer`,
          role: "assistant",
          content: "Made-up answer",
          created_at: new Date().toISOString()
        }
      ]
    })
  })

export const claimAll = (workerId: string) =>
  Effect.gen(function* () {
    const queue = yield* AutomationQueue
    return yield* Effect.promise(async () =>
      queue.jobs.claim({
        workerId,
        now: Date.now() + 60 * 60_000,
        limit: 10,
        leaseDurationMs: 60_000
      })
    )
  })

export type JobLease = Effect.Success<ReturnType<typeof claimAll>>[number]

const startJob = (lease: JobLease, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const automationId = lease.payload.automationId
    const [job] = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM scheduled_tasks WHERE task_id = ${automationId}`
    if (job === undefined) throw new Error(`${automationId} has no chat`)
    const run = yield* startChat(job.thread_id, id, {
      automation: {
        automationId,
        attemptId: lease.payload.automationRunId,
        lease: { id: lease.id, token: lease.token }
      }
    })
    return { run, sessionId: job.thread_id }
  })

const completeJob = (
  lease: JobLease,
  ran: { readonly runId: string; readonly sessionId: string } | null,
  outcome: "finished" | "no_change" | "failed" = ran === null ? "no_change" : "finished"
) =>
  Effect.gen(function* () {
    const queue = yield* AutomationQueue
    yield* Effect.promise(async () =>
      Promise.resolve(
        queue.jobs.complete({
          ...lease,
          completedAt: Date.now() + 60 * 60_000,
          result: {
            status: "ended",
            outcome,
            result: outcome === "failed" ? null : "Made-up result",
            error: outcome === "failed" ? "Made-up failure" : null,
            chatRunId: ran?.runId ?? null,
            chatSessionId: ran?.sessionId ?? null
          }
        })
      )
    )
  })

export const runJob = <R>(
  lease: JobLease,
  id: string,
  act: (runId: string) => Effect.Effect<void, unknown, R>
) =>
  Effect.gen(function* () {
    const started = yield* startJob(lease, id)
    yield* act(started.run.runId)
    yield* finishChat(started.run, id)
    yield* completeJob(lease, { runId: started.run.runId, sessionId: started.sessionId })
  })

export const endJobWithoutRun = (lease: JobLease) => completeJob(lease, null)

export const failJob = (lease: JobLease) => completeJob(lease, null, "failed")

export const startJobs = (ids: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const leases = yield* claimAll("wakes")
    const runs = new Map<string, string>()
    for (const [automationId, id] of Object.entries(ids)) {
      const lease = leases.find((entry) => entry.payload.automationId === automationId)
      if (lease === undefined) throw new Error(`${automationId} was not claimed`)
      runs.set(automationId, (yield* startJob(lease, id)).run.runId)
    }
    return runs
  })
