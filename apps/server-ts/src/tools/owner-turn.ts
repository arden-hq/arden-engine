import { ToolExecutionError } from "@arden-hq/loop"
import { Effect } from "effect"

import { boundary, type Target } from "../execution/decide.js"
import type { SessionHistoryHeader } from "../persistence/sessions/model.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import { refusalError } from "./refusal.js"
import type { ServerRunContext } from "./run-context.js"

/**
 * The chat of the run, once it is shown to be the owner's own turn: no automation, helper or
 * other agent acts for the owner here. `doing` and `what` word the refusals.
 */
export const requireOwnerTurn = async (
  sessions: Pick<SessionQueries["Service"], "loadHistoryHeader">,
  run: ServerRunContext,
  signal: AbortSignal,
  owned: {
    readonly target: Extract<Target, { readonly kind: "directives" | "memory_forget" }>
    readonly doing: string
    readonly what: string
  }
): Promise<SessionHistoryHeader> => {
  const unverified = (retryable: boolean) =>
    new ToolExecutionError(`The current Session could not be verified before ${owned.doing}.`, {
      preview: "Session unavailable",
      retryable
    })
  const header = await Effect.runPromise(
    sessions.loadHistoryHeader(run.sessionId).pipe(Effect.mapError(() => unverified(true))),
    { signal }
  )
  if (header === null) throw unverified(false)
  const verdict = boundary(run.authority, owned.target)
  if (verdict.kind !== "allow")
    throw refusalError({
      what: owned.what,
      rule: "boundary",
      instead: verdict.kind === "deny" ? verdict.instead : []
    })
  return header
}
