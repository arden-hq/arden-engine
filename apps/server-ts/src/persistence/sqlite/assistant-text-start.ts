import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { STREAM_RECORD } from "@arden-hq/protocol/chat"
import { ROLE } from "@arden-hq/std/message-vocabulary"

export const assistantTextStart = (messageId: string): ChatProjectionEvent => ({
  type: "TEXT_MESSAGE_START",
  message_id: messageId,
  record: { kind: STREAM_RECORD.part, record_id: messageId },
  role: ROLE.assistant
})
