import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { AutomationId } from "../../src/persistence/automations/model.js"
import { AutomationQueue } from "../../src/persistence/automations/queue.js"
import { ChatWriteStore, type TaskStepCause } from "../../src/persistence/chat/store.js"

const message = (id: string, isMeta: boolean) => ({
  message_id: id,
  client_id: id,
  content: "Made-up words",
  created_at: new Date().toISOString(),
  ...(isMeta
    ? { role: ROLE.interaction, from: { source: "harness", id: "notice" }, kind: "event" }
    : { role: ROLE.user })
})

const startChat = (
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
              role: ROLE.interaction,
              kind: "assignment",
              from: {
                source: "automation",
                id: options.automation.automationId,
                name: "Made-up job"
              },
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

type JobLease = Effect.Success<ReturnType<typeof claimAll>>[number]

export const startJob = (lease: JobLease, id: string) =>
  Effect.gen(function* () {
    const automationId = lease.payload.automationId
    const job = { thread_id: lease.payload.sessionId }
    if (job.thread_id === null) throw new Error(`${automationId} has no chat`)
    const run = yield* startChat(job.thread_id, id, {
      automation: {
        automationId,
        attemptId: lease.payload.automationRunId,
        lease: { id: lease.id, token: lease.token }
      }
    })
    return { run, sessionId: job.thread_id }
  })

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
