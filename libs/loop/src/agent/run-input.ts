import { isConversationalInput, isHumanMessage } from "./interactions.js"
import { type ChatMessage } from "../contracts/messages.js"
import { hookCall } from "./guards.js"
import { decodeMessages } from "../internal/validate.js"
import { type Run } from "./run-state.js"

export const stepFinished = (run: Run): Promise<void> =>
  run.history.checkpoint((messages, change) =>
    hookCall("onStepFinish", () =>
      run.wiring.hooks.onStepFinish?.(run.state.step, run.state.lastResponse, messages, change)
    )
  )

export const drainPending = async (run: Run): Promise<number> => {
  const pending = await hookCall(
    "getPendingMessages",
    () => run.wiring.hooks.getPendingMessages?.() ?? []
  )
  if (pending.length === 0) return 0
  const valid = decodeMessages(pending)
  if (valid.some(isConversationalInput)) run.state.inputAdmission.pending = true
  run.messages.push(...valid)
  if (valid.some((message) => isOwnerMessage(run, message))) await announceInputTaken(run)
  return valid.length
}

export const isOwnerMessage = (run: Run, message: ChatMessage): boolean =>
  (run.wiring.hooks.isOwnerMessage ?? isHumanMessage)(message)

export const announceInputTaken = (run: Run): Promise<void> =>
  run.emit({ _tag: "InputTaken", depth: 0, parent_id: null })
