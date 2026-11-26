import type { MessageOrigin } from "../../contracts/messages.js"

export type MessageRoute = Pick<MessageOrigin, "provider" | "api" | "requested_model">

export const sameRoute = (origin: MessageOrigin, route: MessageRoute): boolean =>
  origin.provider === route.provider &&
  origin.api === route.api &&
  origin.requested_model === route.requested_model
