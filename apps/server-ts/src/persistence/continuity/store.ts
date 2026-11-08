import { storeReasons } from "../errors.js"
import type {
  AcknowledgeSpaceContinuityRequest,
  SpaceContinuitySeenState,
  SpaceContinuityStateResponse
} from "@arden-hq/protocol/spaces/continuity"
import { Context, Effect, Schema } from "effect"

export class CommunicationStoreError extends Schema.TaggedError<CommunicationStoreError>()(
  "CommunicationStoreError",
  {
    reason: storeReasons(["invalid", "not_found", "conflict", "storage"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export interface CommunicationDelivery {
  readonly deliveryId: string
  readonly attempt: number
}

export class CommunicationStore extends Context.Service<
  CommunicationStore,
  {
    readonly state: (
      spaceId: string
    ) => Effect.Effect<SpaceContinuityStateResponse, CommunicationStoreError>
    readonly acknowledge: (
      spaceId: string,
      input: AcknowledgeSpaceContinuityRequest
    ) => Effect.Effect<SpaceContinuitySeenState, CommunicationStoreError>
    readonly pendingDeliveries: () => Effect.Effect<
      ReadonlyArray<CommunicationDelivery>,
      CommunicationStoreError
    >
    readonly deliverEnvelope: (
      delivery: CommunicationDelivery
    ) => Effect.Effect<boolean, CommunicationStoreError>
    readonly deferDelivery: (
      delivery: CommunicationDelivery,
      cause: string
    ) => Effect.Effect<void, CommunicationStoreError>
  }
>()("@arden-hq/server/persistence/continuity/CommunicationStore") {}
