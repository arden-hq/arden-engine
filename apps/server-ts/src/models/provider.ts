import type { CompletionResponse, ModelProvider, ResponseFormat } from "@arden-hq/loop"
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import type { PlanLimitsSource } from "./plan-limits.js"
import type { StructuredOutputDialect } from "./structured-output.js"

export interface ApprovalReviewSource {
  readonly modelId: string
  readonly complete: (input: {
    readonly system: string
    readonly user: string
    readonly responseFormat: ResponseFormat
    readonly signal: AbortSignal
  }) => Promise<CompletionResponse>
}

export interface TranscriptionSource {
  readonly transcribe: (
    audio: { readonly bytes: Uint8Array; readonly mediaType: string },
    signal: AbortSignal
  ) => Promise<string>
}

export interface ModelRoute {
  readonly provider: ModelProvider
  readonly structuredOutputDialect: StructuredOutputDialect
  readonly approvalReview: ApprovalReviewSource | undefined
  readonly planLimits: PlanLimitsSource | undefined
  /**
   * Whether `planLimits` counts requests to this model. Every model of a
   * route is on its plan, except a saved model server's beside ChatGPT's:
   * the plan neither meters nor pauses them.
   */
  readonly planMeters: (model: string) => boolean
  readonly transcription: TranscriptionSource | undefined
}

export interface ModelRouteInput {
  readonly provider: ModelProvider | undefined
  readonly structuredOutputDialect?: StructuredOutputDialect | undefined
  readonly approvalReview?: ApprovalReviewSource | undefined
  readonly planLimits?: PlanLimitsSource | undefined
  readonly planMeters?: ((model: string) => boolean) | undefined
  readonly transcription?: TranscriptionSource | undefined
}

/** The plan reading that applies to a request to `model`, if any. */
export const planReadingFor = (route: ModelRoute | undefined, model: string) =>
  route !== undefined && route.planMeters(model) ? route.planLimits?.latest() : undefined

export class ModelProviderService extends Context.Service<
  ModelProviderService,
  {
    readonly current: () => ModelRoute | undefined
    readonly changes: Stream.Stream<ModelRoute | undefined>
    readonly replace: (next: ModelRouteInput) => Effect.Effect<void>
  }
>()("@arden-hq/server/models/ModelProviderService") {
  static readonly layer = (initial: ModelRouteInput) =>
    Layer.effect(
      ModelProviderService,
      Effect.gen(function* () {
        const route = yield* SubscriptionRef.make(modelRoute(initial))
        return ModelProviderService.of({
          current: () => SubscriptionRef.getUnsafe(route),
          changes: SubscriptionRef.changes(route),
          replace: (next) => SubscriptionRef.set(route, modelRoute(next))
        })
      })
    )
}

const modelRoute = ({
  provider,
  structuredOutputDialect = "openai",
  planLimits,
  planMeters = everyModel,
  approvalReview,
  transcription
}: ModelRouteInput): ModelRoute | undefined =>
  provider === undefined
    ? undefined
    : { provider, structuredOutputDialect, planLimits, planMeters, approvalReview, transcription }

const everyModel = (): boolean => true
