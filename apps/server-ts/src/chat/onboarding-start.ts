import { Effect, Semaphore } from "effect"
import type { SessionStore } from "../persistence/sessions/store.js"
import type { ChatMessageFailure } from "./message-errors.js"
import { onboardingKickoff, type ChatSendInput } from "./message-input.js"

export const makeOnboardingStart = Effect.fn("makeOnboardingStart")(function* (services: {
  readonly store: Pick<SessionStore["Service"], "onboardingKickedOff">
  readonly send: (input: ChatSendInput) => Effect.Effect<unknown, ChatMessageFailure>
}) {
  const one = (yield* Semaphore.make(1)).withPermit
  return Effect.fn("OnboardingStart")(function* (sessionId: string) {
    return yield* one(
      Effect.gen(function* () {
        if (yield* services.store.onboardingKickedOff(sessionId)) return false
        yield* services.send({ ...onboardingKickoff(sessionId), opensOnboarding: true })
        return true
      })
    )
  })
})
