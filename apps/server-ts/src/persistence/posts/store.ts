import type { JobLeaseRef } from "@arden-hq/jobs"
import { Context, Effect, Schema } from "effect"
import type { AutomationId } from "../automations/model.js"
import type { PostTask } from "./model.js"

export class PostStoreError extends Schema.TaggedError<PostStoreError>()("PostStoreError", {
  reason: Schema.Literals(["invalid", "conflict", "storage"] as const),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export interface PostInput {
  readonly automationId: AutomationId
  readonly attemptId: number
  readonly lease: JobLeaseRef
  readonly runId: string
  readonly spaceId: string | undefined
  readonly text: string
  readonly task: PostTask | undefined
  readonly itemIds: ReadonlyArray<string>
}

export interface PostedMessage {
  readonly sessionId: string
  readonly messageId: string
}

export interface PostDelivery {
  readonly deliveryId: string
  readonly attempt: number
}

export class PostStore extends Context.Service<
  PostStore,
  {
    readonly post: (input: PostInput) => Effect.Effect<PostedMessage, PostStoreError>
    readonly pendingDeliveries: () => Effect.Effect<ReadonlyArray<PostDelivery>, PostStoreError>
    readonly deliver: (delivery: PostDelivery) => Effect.Effect<boolean, PostStoreError>
    readonly defer: (delivery: PostDelivery, cause: string) => Effect.Effect<void, PostStoreError>
  }
>()("@arden-hq/server/persistence/posts/PostStore") {}
