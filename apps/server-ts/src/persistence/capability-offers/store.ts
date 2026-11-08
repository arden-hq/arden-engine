import { Context, Schema, type Effect } from "effect"
import { storeReasons } from "../errors.js"
import type { ConnectedServer, OfferCandidate } from "./match.js"

export class CapabilityOfferStoreError extends Schema.TaggedError<CapabilityOfferStoreError>()(
  "CapabilityOfferStoreError",
  {
    reason: storeReasons(["storage"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export type DeclineResult = "declined" | "already_answered" | "unknown"

export class CapabilityOfferStore extends Context.Service<
  CapabilityOfferStore,
  {
    readonly record: (input: {
      readonly sessionId: string
      readonly runId: string
      readonly toolCallId: string
      readonly candidates: ReadonlyArray<OfferCandidate>
      readonly connected: ReadonlyArray<ConnectedServer>
    }) => Effect.Effect<void, CapabilityOfferStoreError>
    readonly connected: (
      server: ConnectedServer
    ) => Effect.Effect<ReadonlyArray<string>, CapabilityOfferStoreError>
    readonly list: (sessionId: string) => Effect.Effect<
      ReadonlyArray<{
        readonly toolCallId: string
        readonly outcome: "connected" | "declined" | "expired" | null
        readonly offeredAt: string
      }>,
      CapabilityOfferStoreError
    >
    readonly decline: (input: {
      readonly sessionId: string
      readonly toolCallId: string
    }) => Effect.Effect<DeclineResult, CapabilityOfferStoreError>
  }
>()("@arden-hq/server/persistence/capability-offers/CapabilityOfferStore") {}
