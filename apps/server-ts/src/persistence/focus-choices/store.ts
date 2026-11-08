import { storeReasons } from "../errors.js"
import type {
  FocusChoice,
  ResolveFocusChoiceInput,
  ResolveFocusChoiceResponse
} from "@arden-hq/protocol/sessions/focus-choices"
import { Context, Effect, Schema } from "effect"

export class FocusChoiceStoreError extends Schema.TaggedError<FocusChoiceStoreError>()(
  "FocusChoiceStoreError",
  {
    reason: storeReasons(["invalid", "not_found", "conflict", "storage"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export interface ThreadRecord {
  readonly threadId: string
  readonly name: string
  readonly side: "source" | "target"
  readonly location: "source" | "target"
  readonly transition: "moved" | "brought_back"
  readonly at: string
  readonly source: { readonly ref: string; readonly name: string }
  readonly target: { readonly ref: string; readonly name: string }
}

export class FocusChoiceStore extends Context.Service<
  FocusChoiceStore,
  {
    readonly get: (
      spaceId: string,
      questionId: string
    ) => Effect.Effect<FocusChoice, FocusChoiceStoreError>
    readonly resolve: (
      spaceId: string,
      questionId: string,
      input: ResolveFocusChoiceInput
    ) => Effect.Effect<ResolveFocusChoiceResponse, FocusChoiceStoreError>
    readonly bringBack: (input: {
      readonly threadId: string
      readonly sessionId: string
      readonly clientId: string
    }) => Effect.Effect<void, FocusChoiceStoreError>
    readonly threads: (
      sessionId: string
    ) => Effect.Effect<ReadonlyArray<ThreadRecord>, FocusChoiceStoreError>
  }
>()("@arden-hq/server/persistence/focus-choices/FocusChoiceStore") {}
