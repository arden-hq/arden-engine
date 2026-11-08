import { Effect, Layer } from "effect"

import { ConversationArtifacts } from "../artifacts/conversation.js"
import { SessionStore } from "../persistence/sessions/store.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import { SessionFileCleanup } from "../storage/session-file-cleanup.js"
import { ChatStop } from "./chat-stop.js"

interface ForkServices {
  readonly store: SessionStore["Service"]
  readonly artifacts: ConversationArtifacts["Service"]
  readonly stop: ChatStop["Service"]
  readonly cleanup: SessionFileCleanup["Service"]
}

export const makeForkPreparation = ({ store, artifacts, stop, cleanup }: ForkServices) => {
  const discard = Effect.fn("SessionFork.discard")(function* (childSessionId: string) {
    const [found] = yield* store.preparingForks({ childSessionId })
    if (found === undefined) return
    if (found.hasOwnerContent) {
      yield* Effect.logWarning("Kept a fork that could not prepare: it holds the owner's work", {
        childSessionId
      })
      return
    }
    const ended = yield* stop.end({ sessionId: childSessionId, action: "delete", stop: false })
    if (ended.kind === "running") {
      yield* Effect.logWarning("Kept a fork that could not prepare: it has work running", {
        childSessionId
      })
      return
    }
    yield* cleanup.drainAfterDelete()
  })
  const finishOrDiscard = Effect.fn("SessionFork.finishOrDiscard")(function* (fork: {
    readonly sourceSessionId: string
    readonly childSessionId: string
  }) {
    return yield* artifacts.branch(fork.sourceSessionId, fork.childSessionId).pipe(
      Effect.andThen(store.completeBranchPreparation({ childSessionId: fork.childSessionId })),
      Effect.tapError((error) =>
        discard(fork.childSessionId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not discard a fork that failed to prepare", {
              childSessionId: fork.childSessionId,
              error,
              cause
            })
          )
        )
      )
    )
  })
  return { finishOrDiscard }
}

export const SessionForkRecovery: Layer.Layer<
  never,
  never,
  SessionStore | ConversationArtifacts | ChatStop | SessionFileCleanup
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const lifecycle = yield* ServerLifecycle
    const store = yield* SessionStore
    const forks = makeForkPreparation({
      store,
      artifacts: yield* ConversationArtifacts,
      stop: yield* ChatStop,
      cleanup: yield* SessionFileCleanup
    })
    yield* lifecycle.background(
      Effect.gen(function* () {
        for (const fork of yield* store.preparingForks()) {
          yield* forks.finishOrDiscard(fork).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not recover a preparing fork", {
                childSessionId: fork.childSessionId,
                cause
              })
            )
          )
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Could not list preparing forks", { cause }))
      )
    )
  })
)
