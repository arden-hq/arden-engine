import { Effect } from "effect"
import type { SessionStore } from "../persistence/sessions/store.js"
import type { ChatMessageFailure } from "./message-errors.js"
import { onboardingKickoff, type ChatSendInput } from "./message-input.js"

export const makeOnboardingStart = (services: {
  readonly store: Pick<SessionStore["Service"], "markOnboarding">
  readonly send: (input: ChatSendInput) => Effect.Effect<unknown, ChatMessageFailure>
}) =>
  Effect.fn("OnboardingStart")(function* (sessionId: string) {
    if ((yield* services.store.markOnboarding(sessionId)) === "kicked_off") return false
    yield* services.send(onboardingKickoff(sessionId))
    return true
  })
