/**
 * How a piece of work ended, whichever kind of work it was: `finished`;
 * `failed`; `stopped` (someone stopped it); `restart` (Arden restarted under
 * it, routine and not a verdict); `needs_review` (it ended and asks to be read).
 * Each surface keeps its own grammar for a kind, as a `Record<EndKind, string>`
 * so a new kind fails compilation there.
 */
export type EndKind = "finished" | "failed" | "stopped" | "restart" | "needs_review"

const END_KIND_OF: Readonly<Record<string, EndKind>> = {
  completed: "finished",
  succeeded: "finished",
  failed: "failed",
  error: "failed",
  cancelled: "stopped",
  interrupted: "restart",
  needs_attention: "needs_review"
}

/** The ending a Run, agent, script, Automation run or completion outcome status
 *  names; undefined for a status that is not an ending (running, waiting, unknown). */
export const endKindOf = (status: string | null | undefined): EndKind | undefined =>
  status != null && Object.hasOwn(END_KIND_OF, status) ? END_KIND_OF[status] : undefined

/** A stop the owner does not need to read as a failure: asked for, or a restart's. */
export const isQuietEnd = (kind: EndKind | undefined): boolean =>
  kind === "stopped" || kind === "restart"
