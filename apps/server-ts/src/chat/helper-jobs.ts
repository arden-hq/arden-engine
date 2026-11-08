import { Cause, Effect, Scope, type Semaphore } from "effect"
import { ModelProviderService } from "../models/provider.js"
import { StructuredCompletion } from "../models/structured-completion.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { SessionStore } from "../persistence/sessions/store.js"
import { makeLetterSubject } from "./letter-subject.js"
import { isNamingInput, type ChatSendInput } from "./message-input.js"
import { makeSessionNaming } from "./naming.js"
import { makeRunPurpose, type RunPurposeInput } from "./run-purpose.js"
import { ChatWriteStore } from "../persistence/chat/store.js"
import { ChatEventStore } from "../persistence/events/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { TranscriptQueries } from "../persistence/transcript/queries.js"

export interface HelperJobs {
  readonly scheduleRunPurpose: (
    input: RunPurposeInput & { readonly settled: () => void }
  ) => Effect.Effect<void>
  readonly scheduleNaming: (input: ChatSendInput) => Effect.Effect<void>
  readonly scheduleLetterSubject: (
    sessionId: string,
    input: { readonly messageId: string; readonly text: string }
  ) => Effect.Effect<void>
}

export const makeHelperJobs = Effect.fn("ChatMessage.helperJobs")(function* (input: {
  readonly lifecycle: Semaphore.Semaphore
}): Effect.fn.Return<
  HelperJobs,
  never,
  | Scope.Scope
  | ModelProviderService
  | StructuredCompletion
  | SessionQueries
  | SessionStore
  | SpaceStore
  | ChatWriteStore
  | ChatEventStore
  | RunQueries
  | TranscriptQueries
> {
  const serverScope = yield* Scope.Scope
  const namingControllers = new Map<string, AbortController>()
  yield* Scope.addFinalizer(
    serverScope,
    Effect.sync(() => {
      for (const controller of namingControllers.values()) controller.abort()
      namingControllers.clear()
    })
  )
  const completion = yield* StructuredCompletion
  const sessions = yield* SessionQueries
  const sessionStore = yield* SessionStore
  const spaces = yield* SpaceStore
  const modelProvider = yield* ModelProviderService
  const store = yield* ChatWriteStore
  const events = yield* ChatEventStore
  const runs = yield* RunQueries
  const transcript = yield* TranscriptQueries
  const purpose = makeRunPurpose({
    completion,
    lifecycle: input.lifecycle,
    store,
    events,
    runs,
    transcript
  })
  const naming = makeSessionNaming({ completion, sessions, store: sessionStore })
  const letterSubject = makeLetterSubject({ completion, sessions, spaces })
  const unavailable = (): boolean => modelProvider.current() === undefined

  const scheduleNaming = (send: ChatSendInput): Effect.Effect<void> =>
    isNamingInput(send)
      ? scheduleNamingJob(send.sessionId, (signal) =>
          naming({
            sessionId: send.sessionId,
            text: send.message,
            images: send.images ?? [],
            signal
          })
        )
      : Effect.void

  const scheduleNamingJob = (
    sessionId: string,
    work: (signal: AbortSignal) => Effect.Effect<boolean, unknown>
  ): Effect.Effect<void> => {
    if (unavailable() || namingControllers.has(sessionId)) {
      return Effect.void
    }
    const controller = new AbortController()
    namingControllers.set(sessionId, controller)
    const job = work(controller.signal).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Could not generate the Session name", {
              sessionId,
              cause
            })
      ),
      Effect.ensuring(
        input.lifecycle.withPermit(
          Effect.sync(() => {
            if (namingControllers.get(sessionId) === controller) {
              namingControllers.delete(sessionId)
            }
            controller.abort()
          })
        )
      )
    )
    return Effect.forkIn(job, serverScope).pipe(Effect.asVoid)
  }

  const scheduleLetterSubject: HelperJobs["scheduleLetterSubject"] = (sessionId, subject) => {
    if (unavailable()) return Effect.void
    const job = letterSubject({ sessionId, ...subject }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Could not generate the letter subject", {
              sessionId,
              messageId: subject.messageId,
              cause
            })
      ),
      Effect.asVoid
    )
    return Effect.forkIn(job, serverScope).pipe(Effect.asVoid)
  }

  const scheduleRunPurpose: HelperJobs["scheduleRunPurpose"] = (request) => {
    if (unavailable()) return Effect.sync(request.settled)
    return Effect.forkIn(
      purpose(request).pipe(
        Effect.catchCause((cause) =>
          request.run.signal.aborted || Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Could not describe the current task", {
                runId: request.run.runId,
                cause
              })
        ),
        Effect.ensuring(Effect.sync(request.settled))
      ),
      serverScope
    ).pipe(Effect.asVoid)
  }

  return { scheduleNaming, scheduleLetterSubject, scheduleRunPurpose }
})
