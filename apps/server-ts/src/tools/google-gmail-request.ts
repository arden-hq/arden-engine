import { PauseRequested } from "@arden-hq/loop"
import { DateTime, Effect, Schema } from "effect"
import { TOOL_OUTCOME_UNCERTAIN } from "../persistence/tools/store.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { googleToolFailure, recordGoogleAnswer } from "./google-request.js"
import type { CallEffects } from "../execution/tool-effect.js"
import { gmailThreadTarget } from "../connections/items/gmail.js"
import { gmailThreadUrl } from "@arden-hq/protocol/google"

const SentMessage = Schema.Struct({
  id: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString
})

export const gmailSend = async ({
  google,
  account,
  subject,
  body,
  signal,
  effects
}: {
  readonly google: GoogleToolConnections
  readonly account: string
  readonly subject: string
  readonly body: { readonly raw: string; readonly threadId?: string }
  readonly signal: AbortSignal
  readonly effects: CallEffects
}): Promise<{ readonly id: string; readonly threadId: string; readonly confirmedAt: string }> => {
  const title = subject || "(no subject)"
  if (body.threadId !== undefined) {
    await effects.target({
      ...gmailThreadTarget(body.threadId),
      title,
      href: gmailThreadUrl(account, body.threadId)
    })
  }
  const sent = await Effect.runPromise(
    google
      .request({
        service: "gmail",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal
        },
        accountRef: account
      })
      .pipe(
        Effect.tapError((error) => Effect.sync(() => recordGoogleAnswer(effects, error))),
        Effect.mapError((error) => {
          if (
            (error.reason === "invalid_response" && error.diagnostic.kind === "http") ||
            (error.reason === "provider" &&
              (error.diagnostic.kind === "transport" ||
                (error.diagnostic.kind === "http" && error.diagnostic.reason === "provider")))
          ) {
            return new PauseRequested(TOOL_OUTCOME_UNCERTAIN)
          }
          return googleToolFailure(error, "gmail", account)
        })
      ),
    { signal }
  )
  const decoded = Schema.decodeUnknownOption(SentMessage)(sent.value)
  if (
    decoded._tag === "None" ||
    (body.threadId !== undefined && decoded.value.threadId !== body.threadId)
  ) {
    effects.sent()
    throw new PauseRequested(TOOL_OUTCOME_UNCERTAIN)
  }
  effects.applied()
  if (body.threadId === undefined) {
    await effects.created({
      source: "gmail",
      objectId: decoded.value.id,
      title,
      href: gmailThreadUrl(account, decoded.value.threadId)
    })
  }
  return {
    id: decoded.value.id,
    threadId: decoded.value.threadId,
    confirmedAt: DateTime.formatIso(DateTime.nowUnsafe())
  }
}
