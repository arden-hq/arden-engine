import { answerBlockText, readAnswerBlock } from "@arden-hq/answer-ui"
import { blockHasControls, type AnswerBlockState } from "@arden-hq/answer-ui/state"
import type { ChatRunnerMessage } from "../chat/runner-contract.js"
import { answerBlockBodies } from "@arden-hq/protocol/chat"

const HEADING = "Answer block values"

export const latestAnswer = (
  messages: ReadonlyArray<ChatRunnerMessage>
): { readonly messageId: string; readonly text: string } | undefined => {
  const userIndex = messages.findLastIndex(
    (message) => message.role === "user" && message.is_meta !== true
  )
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "assistant" || typeof message.content !== "string") continue
    if (message.content.trim() === "") continue
    return message.message_id === undefined
      ? undefined
      : { messageId: message.message_id, text: message.content }
  }
  return undefined
}

export const renderAnswerBlockNote = (
  text: string,
  saved: ReadonlyMap<number, AnswerBlockState>
): string | undefined => {
  const blocks = answerBlockBodies(text).flatMap((body, index) => {
    const parsed = readAnswerBlock(body)
    if (parsed === undefined || !blockHasControls(parsed)) return []
    const state = saved.get(index)
    const shown = answerBlockText(body, state)
    if (shown === "") return []
    return [
      [
        `Block ${index + 1}, ${state === undefined ? "as you wrote it" : "as the person set it"}:`,
        shown.replace(/^## /gm, "### ")
      ].join("\n")
    ]
  })
  if (blocks.length === 0) return undefined
  return [
    `## ${HEADING}`,
    "The person can change the controls in your latest answer's blocks. This is what they see now; answer from these values, not the ones you first wrote.",
    ...blocks
  ].join("\n\n")
}
