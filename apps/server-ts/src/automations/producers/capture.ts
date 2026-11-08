import { clipLine } from "@arden-hq/std/text"
import { Effect } from "effect"

import type { AutomationTriggerEvent, EventChat } from "../../persistence/automations/model.js"
import type { CaptureArrivedEvent } from "../../persistence/sessions/internal-events.js"
import type { AutomationEventProducer } from "../event-producer.js"

const NOTE_CHARS = 500

const captureArrivedEvent = (
  capture: CaptureArrivedEvent,
  chat: EventChat
): AutomationTriggerEvent => {
  const note = clipLine(capture.note, NOTE_CHARS)
  return {
    eventType: "capture.arrived",
    eventKey: capture.client_id,
    producedBy: null,
    chainDepth: 0,
    context: {
      capture: {
        via: capture.via,
        note,
        screenshot: capture.screenshot,
        session_id: chat.sessionId,
        session_ref: chat.publicRef,
        chat: chat.name ?? "",
        space: chat.spaceName ?? ""
      }
    }
  }
}

export const captureEventProducer: AutomationEventProducer<"capture.arrived"> = {
  eventType: "capture.arrived",
  source: { kind: "feed" },
  fromJournal: Effect.fnUntraced(function* (record, read) {
    if (record.event.type !== "capture_arrived") return []
    const capture = record.event
    const chat = yield* read.chat(capture.session_id)
    return chat === undefined ? [] : [{ event: captureArrivedEvent(capture, chat) }]
  }),
  failureMessage: "Capture Automation trigger failed"
}
