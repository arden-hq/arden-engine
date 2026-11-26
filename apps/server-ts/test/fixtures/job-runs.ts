import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { AutomationId } from "../../src/persistence/automations/model.js"
import { AutomationQueue } from "../../src/persistence/automations/queue.js"
import type { ClaimedAutomationJobLease } from "../../src/persistence/automations/store.js"
import {
  CHAT_WRITE_START,
  ChatWriteStore,
  type ChatWriteFailure,
  type ChatWriteStartResult,
  type TaskStepCause
} from "../../src/persistence/chat/store.js"

type StartedChat = Extract<ChatWriteStartResult, { readonly _tag: typeof CHAT_WRITE_START.started }>

const message = (id: string, isMeta: boolean) => ({
  message_id: id,
  client_id: id,
  content: "Made-up words",
  created_at: new Date().toISOString(),
  ...(isMeta
    ? { role: ROLE.interaction, from: { source: "harness", id: "notice" }, kind: "event" }
    : { role: ROLE.user })
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
): Effect.Effect<StartedChat, ChatWriteFailure, ChatWriteStore> =>
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
    if (started._tag !== CHAT_WRITE_START.started)
      throw new Error(`Run ${id} did not start: ${started._tag}`)
    return started
  })

export const claimAll = (
  workerId: string
): Effect.Effect<ReadonlyArray<ClaimedAutomationJobLease>, never, AutomationQueue> =>
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

type JobLease = ClaimedAutomationJobLease

export const startJob = (
  lease: JobLease,
  id: string,
  sessionId = lease.payload.sessionId
): Effect.Effect<
  { readonly run: StartedChat; readonly sessionId: string },
  ChatWriteFailure,
  ChatWriteStore
> =>
  Effect.gen(function* () {
    const automationId = lease.payload.automationId
    if (sessionId === null) throw new Error(`${automationId} has no chat`)
    const run = yield* startChat(sessionId, id, {
      automation: {
        automationId,
        attemptId: lease.payload.automationRunId,
        lease: { id: lease.id, token: lease.token }
      }
    })
    return { run, sessionId }
  })

export const startJobs = (
  ids: Readonly<Record<string, string>>
): Effect.Effect<Map<string, string>, ChatWriteFailure, AutomationQueue | ChatWriteStore> =>
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
