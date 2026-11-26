import { AUTOMATION_CHAT_CHOICE, type AutomationChatChoice } from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import { ownChat } from "./automation-own-chat.js"
import type { AutomationRow, AutomationStoreDeps } from "./automation-rows.js"
import { type AutomationWriteSource } from "./automation-instruction-provenance.js"
import { requireUserChat } from "./automation-user-chat.js"
import type { PersistenceDeps } from "./deps.js"
import { type AutomationStoreError } from "../automations/store.js"
import { type SqlError } from "effect/unstable/sql/SqlError"
import { type SessionLifecycleEventError } from "../sessions/events.js"
import { type UnitOfWork } from "../unit-of-work.js"

export type ChosenThread = (
  chat: AutomationChatChoice,
  row: AutomationRow,
  automationId: string,
  mutation: AutomationWriteSource | undefined
) => Effect.Effect<string, AutomationStoreError | SqlError | SessionLifecycleEventError, UnitOfWork>

export const makeChosenThread = ({
  sql,
  sessionEvents
}: {
  readonly sql: PersistenceDeps["writer"]["sql"]
  readonly sessionEvents: AutomationStoreDeps["sessionEvents"]
}): ChosenThread => {
  const chosenThread = Effect.fn("SqliteAutomationStore.chosenThread")(function* (
    chat: AutomationChatChoice,
    row: AutomationRow,
    automationId: string,
    mutation: AutomationWriteSource | undefined
  ) {
    if (chat.kind === AUTOMATION_CHAT_CHOICE.yours) {
      yield* requireUserChat(sql, chat.session_id, "update", automationId)
      return chat.session_id
    }
    if (row.thread_origin_automation_id === automationId && row.thread_id !== null) {
      return row.thread_id
    }
    return yield* ownChat({
      sql,
      sessionEvents,
      automationId,
      name: row.name,
      model: row.model,
      mutation
    })
  })
  return chosenThread
}
