import type { MessageOrigin } from "../../contracts/messages.js"

/**
 * Whether two assistant turns came from the same provider, wire and model.
 * Opaque replay state (encrypted reasoning, signatures) is bound to the
 * issuer and model that wrote it; an adapter replays it only on a match.
 */
export const sameOrigin = (left: MessageOrigin, right: MessageOrigin): boolean =>
  left.provider === right.provider && left.api === right.api && left.model === right.model
