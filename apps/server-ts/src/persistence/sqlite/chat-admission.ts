import { Effect } from "effect"
import {
  type ChatWriteStore,
  type ChatWriteReceiveInput,
  CHAT_WRITE_STORED,
  type ChatWriteReceiveResult,
  type ChatWriteFailure
} from "../chat/store.js"
import type { ModelCatalog } from "../../models/catalog.js"
import type { IntelligenceSettingsStore, LimitSettingsStore } from "../settings/store.js"
import type { ChatRules } from "../chat/rules.js"
import { mapFailure } from "./chat-write-errors.js"
import { type PersistenceDeps } from "./deps.js"
import { type AdmissionDeps, admissionContext } from "./chat-admission-context.js"
import { admissionGate } from "./chat-admission-gate.js"
import { admissionMessage } from "./chat-admission-message.js"
import { admissionStart } from "./chat-admission-start.js"

export const makeChatAdmission = ({
  writer,
  chatEvents,
  sessionEvents,
  catalog,
  intelligence,
  limits,
  rules
}: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents"> & {
  readonly catalog: ModelCatalog["Service"]
  readonly intelligence: IntelligenceSettingsStore["Service"]
  readonly limits: LimitSettingsStore["Service"]
  readonly rules: ChatRules["Service"]
}): Pick<ChatWriteStore["Service"], "start" | "receive" | "prepareReceive"> => {
  const sql = writer.sql
  const deps: AdmissionDeps = {
    sql,
    chatEvents,
    sessionEvents,
    catalog,
    intelligence,
    limits,
    rules
  }
  const prepareReceive = Effect.fn("SqliteChatWriteStore.prepareReceive")(function* (
    input: ChatWriteReceiveInput
  ): Effect.fn.Return<Effect.Effect<ChatWriteReceiveResult, ChatWriteFailure>, ChatWriteFailure> {
    const context = yield* admissionContext(deps, input)
    const { valid } = context

    const admit = Effect.gen(function* () {
      const gate = yield* admissionGate({ ...context, ...deps })
      if ("done" in gate) return gate.done
      const message = yield* admissionMessage({ ...context, ...deps, ...gate.values })
      if ("done" in message) return message.done
      return yield* admissionStart({ ...context, ...deps, ...gate.values, ...message.values })
    })
    return writer
      .transactInteractive(admit)
      .pipe(Effect.mapError(mapFailure("start", { sessionId: valid.sessionId })))
  })

  const receive: ChatWriteStore["Service"]["receive"] = (input) =>
    prepareReceive(input).pipe(Effect.flatten)

  return {
    prepareReceive,
    receive,
    start: (input) =>
      receive({ ...input, wake: true }).pipe(
        Effect.flatMap((result) =>
          result._tag === CHAT_WRITE_STORED.stored
            ? Effect.die("A waking admission cannot store an idle message")
            : Effect.succeed(result)
        )
      )
  }
}
