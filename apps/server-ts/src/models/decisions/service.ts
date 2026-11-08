import type { JsonValue } from "@arden-hq/protocol"
import type { DecisionSiteId } from "@arden-hq/protocol/model-endpoints"
import { Context, Duration, Effect, Layer } from "effect"

import { UsageStore } from "../../persistence/usage/store.js"
import { meteredModelCall } from "../call-usage.js"
import { type EndpointFailureReason, failureForStatus } from "../endpoints/failure.js"
import { StructuredCompletion, type CompletionImage } from "../structured-completion.js"
import { decisionsFormatBackend } from "./decisions-format.js"
import type { DecisionEndpoint } from "./endpoint.js"
import { llmDecisionBackend } from "./llm.js"
import {
  type DecisionBackend,
  type DecisionInput,
  type DecisionOption,
  type DecisionQuestion,
  type DecisionResult,
  type ScalarDecisionQuestion,
  DecisionsError,
  validateDecisionInput
} from "./questions.js"
import { decisionVisionProbe, readsProbeImages } from "./vision-probe.js"
import { DECISION_SITES } from "./sites.js"
import { DecisionEndpointSource, type SelectedDecisionEndpoint } from "./source.js"
import { systemOneFormatBackend } from "./systemone-format.js"

type EndpointProbe =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly reason: EndpointFailureReason; readonly message: string }

interface DecisionEndpointCheck {
  readonly text: EndpointProbe
  readonly image: EndpointProbe | "not_declared"
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

export type Decided<V> =
  | { readonly by: "default"; readonly value: V }
  | {
      readonly by: "decision_model"
      readonly value: V
      readonly backend: string
      readonly probability: number
    }
  | { readonly by: "helper"; readonly value: V; readonly backend: string }

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
        input.fallback === "none" ||
        Object.values(input.questions).some((question) => question.kind === "box")
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
          if (input.images.length > 0 && selected.endpoint.input === "text")
            return yield* fallback(input, "The decision model does not read images")
          const asked = ask(selected, input)
          if (
            input.fallback === "none" ||
            Object.values(input.questions).some((question) => question.kind === "box")
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
        const fallback: Decided<AnswerValue<Q>> = { by: "default", value: request.default }
        return classify({
          instructions: site.instructions,
          state: request.state,
          images: request.images ?? [],
          questions: { [site.question]: request.question },
          usage: { kind: request.site, owner: { type: "none" } },
          fallback: site.helper === "answers" ? "helper" : "none",
          ...(request.signal === undefined ? {} : { signal: request.signal })
        }).pipe(
          Effect.map((result) => {
            const answer = result.answers[site.question]
            if (answer === undefined || answer.kind === "box") return fallback
            const value = answer.value as AnswerValue<Q>
            switch (answer.distribution.kind) {
              case "selected-only":
                return site.helper === "answers"
                  ? { by: "helper" as const, value, backend: result.backend }
                  : fallback
              case "calibrated": {
                const probability = answer.distribution.probabilities[String(answer.value)] ?? 0
                return probability >= site.threshold
                  ? { by: "decision_model" as const, value, backend: result.backend, probability }
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
    case "decisions":
      return decisionsFormatBackend(endpoint)
    case "openrouter-decisions":
    case "llama-systemone":
    case "systemone":
      return systemOneFormatBackend(endpoint)
  }
}

const endpointFailureOf = (
  error: Pick<DecisionsError, "reason" | "status">
): EndpointFailureReason => {
  switch (error.reason) {
    case "unavailable":
      return "key_refused"
    case "provider":
      return error.status === undefined ? "unreachable" : failureForStatus(error.status)
    case "invalid_output":
    case "refused":
    case "invalid_request":
      return "wrong_format"
  }
}

const runtimeFailureOf = (error: DecisionsError): EndpointFailureReason | undefined =>
  error.reason === "unavailable" || error.reason === "provider"
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
    endpoint.input === "text+image" && text.ok
      ? yield* probe(backend, true)
      : ("not_declared" as const)
  return { text, image } satisfies DecisionEndpointCheck
})
