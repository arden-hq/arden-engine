import { Effect, Layer, Stream } from "effect"
import { ChatMessage } from "../chat/message.js"
import { SessionLifecycleEvents } from "../persistence/sessions/events.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import { ScriptRunner } from "./script-runner.js"

export const FencedScriptsRuntime: Layer.Layer<
  never,
  never,
  ChatMessage | ScriptRunner | SessionLifecycleEvents
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const chat = yield* ChatMessage
    const scripts = yield* ScriptRunner
    const events = yield* SessionLifecycleEvents
    const lifecycle = yield* ServerLifecycle
    const cancelFenced = scripts
      .cancelFenced({ cancelAgent: (agent) => Effect.runPromise(chat.stopRuns([agent.runId])) })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not stop the scripts of a fenced run", { cause })
        )
      )
    yield* lifecycle.background(
      Effect.gen(function* () {
        const follow = yield* events.open()
        yield* cancelFenced
        yield* follow.stream.pipe(
          Stream.filter(
            (delivery) => delivery.kind === "reset" || delivery.event.type === "run_fenced"
          ),
          Stream.runForEach(() => cancelFenced)
        )
      })
    )
  })
)
