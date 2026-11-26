import { type OfferSource } from "../persistence/permissions/offer.js"
import type { ServerTool } from "./define.js"
import type { ServerToolRun } from "../chat/runner-contract.js"
import { type OfferRequest, type OfferOutcome } from "./permission-offer.js"

export interface PermissionOffers {
  readonly offer: (input: {
    readonly run: ServerToolRun
    readonly toolCallId: string
    readonly request: OfferRequest
    readonly tools: ReadonlyArray<ServerTool>
    readonly source: OfferSource
  }) => Promise<OfferOutcome>
  readonly read: (
    run: ServerToolRun,
    tools: ReadonlyArray<ServerTool>
  ) => Promise<{
    mode: string
    modeSetBy: string
    rules: { id: string; list: string; decision: "ask" | "allow" | "never"; rule: string }[]
    ownChecks: string[]
  }>
}
