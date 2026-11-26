import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"

import type { SentReceipt, ServerRunContext } from "./run-context.js"
import { type SessionListEntry } from "../persistence/sessions/store.js"
import { errorMessage } from "@arden-hq/std/errors"
import { type StoredCapture } from "../persistence/sessions/capture.js"
import { type SessionActionToolServices, resolveSession } from "./session-action-access.js"

export const handedOver = (capture: StoredCapture | undefined): boolean =>
  capture !== undefined && capture.forwarded === undefined

type DeliveryRequest = Omit<Parameters<ServerRunContext["sendMessage"]>[0], "sessionId">

export const deliverToSession = async (
  services: SessionActionToolServices,
  ctx: ToolContext<ServerRunContext>,
  tool: "session_send_message" | "forward_message",
  sessionRef: string,
  handed: boolean,
  request: (target: SessionListEntry) => DeliveryRequest
): Promise<{ readonly target: SessionListEntry; readonly receipt: SentReceipt }> => {
  const target = await resolveSession(
    services,
    { run: ctx.run, tool, verb: "message", handed, approval: ctx.approval },
    sessionRef,
    ctx.signal
  )
  if (target.sessionId === ctx.run.sessionId) {
    throw new ToolExecutionError("A message cannot be delivered to the chat it comes from", {
      preview: "Same chat",
      retryable: false
    })
  }
  const receipt = await ctx.run
    .sendMessage({ sessionId: target.sessionId, ...request(target), announce: true })
    .catch((cause: unknown) => {
      throw new ToolExecutionError(errorMessage(cause, "The message could not be delivered"), {
        preview: "Message not delivered",
        retryable: true
      })
    })
  return { target, receipt }
}
