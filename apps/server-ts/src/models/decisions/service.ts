import type { JsonValue } from "@arden-hq/protocol"
import { MODEL_ENDPOINT_INPUT, type DecisionSiteId } from "@arden-hq/protocol/model-endpoints"
import { Context, Duration, Effect, Layer } from "effect"

import { UsageStore } from "../../persistence/usage/store.js"
import { meteredModelCall } from "../call-usage.js"
import { type EndpointFailureReason, failureForStatus } from "../endpoints/failure.js"
import { StructuredCompletion, type CompletionImage } from "../structured-completion.js"
import { decisionsFormatBackend } from "./decisions-format.js"
import { DECISION_WIRE_FORMAT, type DecisionEndpoint } from "./endpoint.js"
import { llmDecisionBackend } from "./llm.js"
import {
  type DecisionBackend,
  type DecisionInput,
  type DecisionOption,
  type DecisionQuestion,
  type DecisionResult,
  type ScalarDecisionQuestion,
  DECISION_DISTRIBUTION,
  DECISION_FALLBACK,
  DECISION_KIND,
  DECISIONS_ERROR_REASON,
  DecisionsError,
  validateDecisionInput
} from "./questions.js"
import { decisionVisionProbe, readsProbeImages } from "./vision-probe.js"
import { DECISION_SITES } from "./sites.js"
import { DecisionEndpointSource, type SelectedDecisionEndpoint } from "./source.js"
import { systemOneFormatBackend } from "./systemone-format.js"

export const IMAGE_PROBE = { notDeclared: "not_declared" } as const

type EndpointProbe =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly reason: EndpointFailureReason; readonly message: string }

interface DecisionEndpointCheck {
  readonly text: EndpointProbe
  readonly image: EndpointProbe | typeof IMAGE_PROBE.notDeclared
}

export type AnswerValue<Q extends DecisionQuestion> = Q extends { readonly kind: "predicate" }
  ? boolean
  : Q extends { readonly kind: "choice"; readonly options: ReadonlyArray<DecisionOption> }
    ? Q["options"][number]["value"]
    : Q extends { readonly kind: "score"; readonly levels: ReadonlyArray<DecisionOption> }
      ? Q["levels"][number]["value"]
      : never

export interface DecisionRequest<Q extends DecisionQuestion> {
  readonly site: DecisionSiteId
  readonly question: Q
  readonly state: JsonValue
  readonly default: AnswerValue<Q>
  readonly images?: ReadonlyArray<CompletionImage>
  readonly signal?: AbortSignal
}

export const DECIDED_BY = {
  default: "default",
  decisionModel: "decision_model",
  helper: "helper"
} as const

export type Decided<V> =
  | { readonly by: typeof DECIDED_BY.default; readonly value: V }
  | {
      readonly by: typeof DECIDED_BY.decisionModel
      readonly value: V
      readonly backend: string
      readonly probability: number
    }
  | { readonly by: typeof DECIDED_BY.helper; readonly value: V; readonly backend: string }

const DECISION_TIMEOUT = "20 seconds"

export class Decisions extends Context.Service<
  Decisions,
  {
    readonly classify: (input: DecisionInput) => Effect.Effect<DecisionResult, DecisionsError>
    readonly decide: <Q extends ScalarDecisionQuestion>(
      request: DecisionRequest<Q>
    ) => Effect.Effect<Decided<AnswerValue<Q>>>
  }
>()("@arden-hq/server/models/Decisions") {
  static readonly layer: Layer.Layer<
    Decisions,
    never,
    StructuredCompletion | DecisionEndpointSource | UsageStore
  > = Layer.effect(
    Decisions,
    Effect.gen(function* () {
      const completion = yield* StructuredCompletion
      const source = yield* DecisionEndpointSource
      const usage = yield* UsageStore
      const helper = llmDecisionBackend(completion)

      const ask = (selected: SelectedDecisionEndpoint, input: DecisionInput) =>
        meteredModelCall(
          usage,
          { ...input.usage, modelId: selected.endpoint.model },
          (onResponse) =>
            endpointBackend({
              ...selected.endpoint,
              onUsage: (usage) => onResponse({ usage })
            }).classify(input)
        ).pipe(
          Effect.tap(() => source.report(selected, undefined)),
          Effect.tapError((error) => {
            if (input.signal?.aborted) return Effect.void
            const failure = runtimeFailureOf(error)
            return failure === undefined ? Effect.void : source.report(selected, failure)
          })
        )

      const fallback = (input: DecisionInput, message: string) =>
        input.fallback === DECISION_FALLBACK.none ||
        Object.values(input.questions).some((question) => question.kind === DECISION_KIND.box)
          ? Effect.fail(new DecisionsError({ reason: "unavailable", message }))
          : helper.classify(input)

      const classify = Effect.fn("Decisions.classify")(
        function* (input: DecisionInput) {
          yield* validateDecisionInput(input)
          if (input.signal?.aborted) {
            return yield* new DecisionsError({
              reason: "unavailable",
              message: "The decision request was cancelled"
            })
          }
          const selected = yield* source.current()
          if (selected === undefined) return yield* fallback(input, "No decision model is selected")
          if (input.images.length > 0 && selected.endpoint.input === MODEL_ENDPOINT_INPUT.text)
            return yield* fallback(input, "The decision model does not read images")
          const asked = ask(selected, input)
          if (
            input.fallback === DECISION_FALLBACK.none ||
            Object.values(input.questions).some((question) => question.kind === DECISION_KIND.box)
          )
            return yield* asked
          return yield* asked.pipe(
            Effect.catch((error) =>
              input.signal?.aborted
                ? Effect.fail(error)
                : Effect.logWarning("The decision endpoint failed; the Helper decides", {
                    reason: error.reason,
                    message: error.message
                  }).pipe(Effect.andThen(helper.classify(input)))
            )
          )
        },
        Effect.timeout(DECISION_TIMEOUT),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new DecisionsError({ reason: "unavailable", message: "The decision timed out" })
          )
        )
      )

      const decide = <Q extends ScalarDecisionQuestion>(
        request: DecisionRequest<Q>
      ): Effect.Effect<Decided<AnswerValue<Q>>> => {
        const site = DECISION_SITES[request.site]
        const fallback: Decided<AnswerValue<Q>> = { by: DECIDED_BY.default, value: request.default }
        return classify({
          instructions: site.instructions,
          state: request.state,
          images: request.images ?? [],
          questions: { [site.question]: request.question },
          usage: { kind: request.site, owner: { type: "none" } },
          fallback: "helper",
          ...(request.signal === undefined ? {} : { signal: request.signal })
        }).pipe(
          Effect.map((result) => {
            const answer = result.answers[site.question]
            if (answer === undefined || answer.kind === DECISION_KIND.box) return fallback
            const value = answer.value as AnswerValue<Q>
            switch (answer.distribution.kind) {
              case DECISION_DISTRIBUTION.selectedOnly:
                return { by: DECIDED_BY.helper, value, backend: result.backend }
              case DECISION_DISTRIBUTION.calibrated: {
                const probability = answer.distribution.probabilities[String(answer.value)] ?? 0
                return probability >= site.threshold
                  ? { by: DECIDED_BY.decisionModel, value, backend: result.backend, probability }
                  : fallback
              }
            }
          }),
          Effect.catch((error) =>
            Effect.logWarning("A decision failed; the default stands", {
              site: request.site,
              reason: "reason" in error ? error.reason : "timeout",
              message: error.message
            }).pipe(Effect.as(fallback))
          )
        )
      }

      return Decisions.of({ decide, classify })
    })
  )
}

const endpointBackend = (endpoint: DecisionEndpoint): DecisionBackend => {
  switch (endpoint.format) {
    case DECISION_WIRE_FORMAT.decisions:
      return decisionsFormatBackend(endpoint)
    case DECISION_WIRE_FORMAT.openrouterDecisions:
    case DECISION_WIRE_FORMAT.llamaSystemone:
    case DECISION_WIRE_FORMAT.systemone:
      return systemOneFormatBackend(endpoint)
  }
}

const endpointFailureOf = (
  error: Pick<DecisionsError, "reason" | "status">
): EndpointFailureReason => {
  switch (error.reason) {
    case DECISIONS_ERROR_REASON.unavailable:
      return "key_refused"
    case DECISIONS_ERROR_REASON.provider:
      return error.status === undefined ? "unreachable" : failureForStatus(error.status)
    case DECISIONS_ERROR_REASON.invalidOutput:
    case DECISIONS_ERROR_REASON.refused:
    case DECISIONS_ERROR_REASON.invalidRequest:
      return "wrong_format"
  }
}

const runtimeFailureOf = (error: DecisionsError): EndpointFailureReason | undefined =>
  error.reason === DECISIONS_ERROR_REASON.unavailable ||
  error.reason === DECISIONS_ERROR_REASON.provider
    ? endpointFailureOf(error)
    : undefined

const probe = (backend: DecisionBackend, vision: boolean): Effect.Effect<EndpointProbe> =>
  backend
    .classify({
      instructions: "Connection check.",
      state: { note: vision ? "Inspect the attached images." : "A text-only request." },
      usage: { kind: "chat_triage", owner: { type: "none" } },
      ...(vision
        ? decisionVisionProbe()
        : {
            images: [],
            questions: {
              ready: { kind: "predicate" as const, instructions: "This request arrived intact." }
            }
          })
    })
    .pipe(
      Effect.timed,
      Effect.map(([elapsed, result]): EndpointProbe => {
        if (vision && !readsProbeImages(result))
          return {
            ok: false,
            reason: "wrong_format",
            message: "The model did not identify the attached images correctly"
          }
        return { ok: true, ms: Math.round(Duration.toMillis(elapsed)) }
      }),
      Effect.catch((error) =>
        Effect.succeed<EndpointProbe>({
          ok: false,
          reason: endpointFailureOf(error),
          message: error.message
        })
      )
    )

export const checkDecisionEndpoint = Effect.fn("Decisions.check")(function* (
  endpoint: DecisionEndpoint
) {
  const backend = endpointBackend(endpoint)
  const text = yield* probe(backend, false)
  const image =
    endpoint.input === MODEL_ENDPOINT_INPUT.textImage && text.ok
      ? yield* probe(backend, true)
      : IMAGE_PROBE.notDeclared
  return { text, image } satisfies DecisionEndpointCheck
})
