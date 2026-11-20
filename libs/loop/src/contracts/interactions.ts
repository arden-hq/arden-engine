import type { InteractionMessage } from "./messages.js"

export const isAgentMail = (message: InteractionMessage): boolean =>
  message.from.source === "agent" &&
  message.to !== undefined &&
  (message.kind === "message" || message.kind === "assignment" || message.kind === "completion")

export const rendersAsText = (message: InteractionMessage): boolean => {
  switch (message.from.source) {
    case "agent":
    case "workflow":
    case "tool":
      return true
    case "automation":
    case "harness":
      return false
  }
}
