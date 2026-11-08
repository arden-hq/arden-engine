/** One capability Arden could gain, taken from a canonical catalog rather than
 *  named by the model — the id is the server's, so a proposal can never point at
 *  something that does not exist. */
export type CapabilityCandidate =
  | {
      readonly kind: "mcp_preset"
      readonly id: string
      readonly title: string
      readonly description: string
      readonly setup_url: string | null
    }

  /** A server the owner gave by URL in their own message. The server accepts it
   *  only when the address occurs verbatim in an owner-authored message of this
   *  session, so `url` is the owner's spelling, never the model's. Nothing
   *  secret rides here: a server that needs headers is offered as a hand-off
   *  to Settings, where the owner types the key. `id` is the normalized URL. */
  | {
      readonly kind: "mcp_custom"
      readonly id: string
      /** The label the connection will carry; it names it and vouches for nothing. */
      readonly title: string
      readonly url: string
      readonly auth: "oauth" | "none" | "headers"
    }

/** The durable payload of one capability proposal.
 *
 *  It rides the tool result, so the fact that Arden asked is preserved with the
 *  turn that asked it. A candidate is only a connection choice; Settings owns
 *  the reviewed connect flow. */
export interface CapabilityProposal {
  readonly need: string
  readonly candidates: ReadonlyArray<CapabilityCandidate>
}
