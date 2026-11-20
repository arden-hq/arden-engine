import { messageId, type InteractionMessage } from "../contracts/messages.js"

export type LoopNotice = "output_limit" | "final_text_check" | "output_schema"

export const harnessNotice = (
  notice: LoopNotice,
  content: string,
  id: string = messageId("text")
): InteractionMessage => ({
  role: "interaction",
  message_id: id,
  from: { source: "harness", id: notice },
  kind: "instruction",
  content
})
