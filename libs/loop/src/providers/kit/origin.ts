import type { MessageOrigin } from "../../contracts/messages.js"

/** Where a request goes: who serves it, the wire, and the model ID it names. */
export type MessageRoute = Pick<MessageOrigin, "provider" | "api" | "requested_model">

/**
 * Whether a stored turn was answered on the route a new request takes: the
 * same provider, wire and requested model ID. Opaque replay state (encrypted
 * reasoning, signatures) is bound to the issuer and model that wrote it, and
 * the requested ID is what reaches that model again: the model a router names
 * in its chunks is not always an ID it routes (OpenRouter drops a `:nitro`
 * suffix), and the model a request will be answered by is unknown until it is.
 */
export const sameRoute = (origin: MessageOrigin, route: MessageRoute): boolean =>
  origin.provider === route.provider &&
  origin.api === route.api &&
  origin.requested_model === route.requested_model
