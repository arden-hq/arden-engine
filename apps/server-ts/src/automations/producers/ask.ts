import { clipLine } from "@arden-hq/std/text"
import { Effect } from "effect"

import type {
  AskFeedRow,
  AskRef,
  AutomationTriggerEvent,
  JournalRecord
} from "../../persistence/automations/model.js"
import type { AutomationEventProducer } from "../event-producer.js"

const TEXT_CHARS = 500

const askWaitingEvent = (row: AskFeedRow): AutomationTriggerEvent => ({
  eventType: "ask.waiting",
  eventKey: row.key,
  producedBy: row.producedBy ?? null,
  chainDepth: row.chainDepth,
  context: {
    ask: {
      kind: row.kind,
      text: clipLine(row.text, TEXT_CHARS),
      ...(row.detail === undefined ? {} : { detail: clipLine(row.detail, TEXT_CHARS) }),
      ...(row.toolName === undefined ? {} : { tool: row.toolName }),
      asked_at: row.askedAt,
      automation: row.automationName ?? "",
      ...(row.chat === undefined
        ? {}
        : {
            session_id: row.chat.sessionId,
            session_ref: row.chat.publicRef,
            chat: row.chat.name ?? "",
            space: row.chat.spaceName ?? ""
          })
    }
  }
})

const ASK_OPEN_FOR_MS = 60_000

const askOpened = ({ event }: JournalRecord): AskRef | undefined => {
  if (event.type === "approval_waiting")
    return { kind: "card", runId: event.run_id, toolCallId: event.tool_call_id }
  if (event.type === "question_changed") return { kind: "question", questionId: event.question_id }
  return undefined
}

export const askWaitingEventProducer: AutomationEventProducer<"ask.waiting"> = {
  eventType: "ask.waiting",
  source: { kind: "feed" },
  fromJournal: Effect.fnUntraced(function* (record, read) {
    const ref = askOpened(record)
    const ask = ref === undefined ? undefined : yield* read.openAsk(ref)
    return ask === undefined
      ? []
      : [{ event: askWaitingEvent(ask), dueAt: record.atMs + ASK_OPEN_FOR_MS }]
  }),
  failureMessage: "Ask Automation trigger failed"
}
