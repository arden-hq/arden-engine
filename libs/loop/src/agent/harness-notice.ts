import { INTERACTION_KIND, INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
import { messageId, type InteractionMessage } from "../contracts/messages.js"

export type LoopNotice = "output_limit" | "final_text_check" | "output_schema"

export const harnessNotice = (
  notice: LoopNotice,
  content: string,
  id: string = messageId("text")
): InteractionMessage => ({
  role: ROLE.interaction,
  message_id: id,
  from: { source: INTERACTION_SOURCE.harness, id: notice },
  kind: INTERACTION_KIND.instruction,
  content
})
