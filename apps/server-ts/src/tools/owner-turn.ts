import { ToolExecutionError } from "@arden-hq/loop"
import { Effect } from "effect"

import { boundary, type Target } from "../execution/decide.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import { refusalError } from "./refusal.js"
import type { ServerRunContext } from "./run-context.js"

interface OwnerTurnRefusalWording {
  /** Completes "The current Session could not be verified before …". */
  readonly unverifiedBefore: string
  readonly notOwnerTurn: string
}

export const requireOwnerTurn = async (
  sessions: Pick<SessionQueries["Service"], "loadHistoryHeader">,
  run: ServerRunContext,
  signal: AbortSignal,
  target: Extract<Target, { readonly kind: "directives" | "memory_forget" }>,
  refusalWording: OwnerTurnRefusalWording
): Promise<void> => {
  const unverified = (retryable: boolean) =>
    new ToolExecutionError(
      `The current Session could not be verified before ${refusalWording.unverifiedBefore}.`,
      { preview: "Session unavailable", retryable }
    )
  const header = await Effect.runPromise(
    sessions.loadHistoryHeader(run.sessionId).pipe(Effect.mapError(() => unverified(true))),
    { signal }
  )
  if (header === null) throw unverified(false)
  const verdict = boundary(run.authority, target)
  if (verdict.kind !== "allow")
    throw refusalError({
      what: refusalWording.notOwnerTurn,
      rule: "boundary",
      instead: verdict.kind === "deny" ? verdict.instead : []
    })
}
