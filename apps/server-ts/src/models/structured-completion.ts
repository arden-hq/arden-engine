import {
  createTool,
  createToolset,
  makeAgent,
  resolveModelCapabilities,
  StructuredOutputError,
  UnsupportedStructuredOutputError,
  ToolChoice,
  type Agent,
  type ChatMessage,
  type AgentConfigInput,
  type CompletionResponse,
  type Result,
  type Tool,
  type Toolset
} from "@arden-hq/loop"
import type { ModelAssignment } from "@arden-hq/protocol/models"
import { Context, Effect, Layer, Schema } from "effect"
import { STRUCTURED_OUTPUT_DIALECTS } from "./structured-output.js"
import { ModelStore } from "../persistence/models/store.js"
import { type ModelCallUsage, UsageStore } from "../persistence/usage/store.js"
import { meteredModelCall } from "./call-usage.js"
import { ModelProviderService, type ModelRoute } from "./provider.js"
import { withUntrustedDataRule } from "./instructions.js"
import { makeModelRequestMeter, responseUsage } from "../chat/model-request-meter.js"
import type { ServerToolRun } from "../chat/runner-contract.js"

interface RunModelUsage {
  readonly kind: "run"
  readonly run: NonNullable<ServerToolRun["modelUsage"]>
}

const noTools: Toolset = Object.freeze({
  entries: () => [],
  loadedNames: () => new Set<string>(),
  load: () => undefined,
  execute: () => {
    throw new Error("Structured completion does not execute tools")
  }
})

export type StructuredCompletionRole = "helper" | { readonly chat: string }

const roleLabel = (role: StructuredCompletionRole): string =>
  role === "helper" ? "Helper" : "Chat"

export class StructuredCompletionError extends Schema.TaggedError<StructuredCompletionError>()(
  "StructuredCompletionError",
  {
    reason: Schema.Literals(["unavailable", "provider", "invalid_output"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export interface CompletionImage {
  readonly mediaType: "image/png" | "image/jpeg"
  readonly data: string
}

export interface StructuredCompletionInput<S extends Schema.ConstraintDecoder<unknown>> {
  readonly role: StructuredCompletionRole
  readonly usage: ModelCallUsage
  readonly system: string
  readonly user: string
  readonly images?: ReadonlyArray<CompletionImage>
  readonly output: S
  readonly onResponse?: (response: CompletionResponse) => void
  readonly outputName: string
  readonly maxOutputTokens: number
  readonly signal?: AbortSignal
}

export interface TextCompletionInput {
  readonly role: StructuredCompletionRole
  readonly usage: ModelCallUsage
  readonly system: string
  readonly user: string
  readonly images?: ReadonlyArray<CompletionImage>
  readonly maxOutputTokens: number
  readonly maxCharacters: number
  readonly signal?: AbortSignal
  readonly onText?: (delta: string) => void
}

export interface ToolCompletionInput<S extends Schema.ConstraintDecoder<unknown>> extends Omit<
  TextCompletionInput,
  "maxCharacters" | "usage"
> {
  readonly usage: ModelCallUsage | RunModelUsage
  readonly result: {
    readonly schema: S
    readonly name: string
    readonly displayName: string
    readonly description: string
  }
  readonly steps?: {
    readonly tools: ReadonlyArray<Tool<void | undefined>>
    readonly maxIterations: number
    readonly maxToolCalls: number
    readonly modelRequestMiddlewares?: AgentConfigInput["modelRequestMiddlewares"]
  }
}

interface ResolvedAssignment {
  readonly assignment: ModelAssignment
  readonly label: string
  readonly model: string
  readonly route: ModelRoute
}

const agentFor = (
  { assignment, model, route }: ResolvedAssignment,
  {
    maxOutputTokens,
    toolChoice,
    toolset,
    onResponse,
    worker,
    maxIterations = 2,
    modelRequestMiddlewares = []
  }: {
    readonly maxOutputTokens: number
    readonly toolChoice: ToolChoice
    readonly toolset: Toolset
    readonly onResponse: (response: CompletionResponse) => void | Promise<void>
    readonly worker?: { readonly maxToolCalls: number }
    readonly maxIterations?: number
    readonly modelRequestMiddlewares?: AgentConfigInput["modelRequestMiddlewares"]
  }
): Agent =>
  makeAgent(
    {
      model,
      maxIterations,
      modelRequestMiddlewares,
      ...(worker === undefined
        ? {}
        : {
            foregroundBudgetMs: Infinity,
            maxToolConcurrency: 1,
            maxToolCalls: worker.maxToolCalls
          }),
      maxOutputTokens,
      toolChoice,
      ...(assignment.reasoningEffort === null
        ? {}
        : { reasoningEffort: assignment.reasoningEffort })
    },
    { provider: route.provider, toolset, hooks: { onResponse } }
  )

const providerFailed = (label: string) => (cause: unknown) =>
  new StructuredCompletionError({
    reason: "provider",
    message: `The ${label} model request failed`,
    cause
  })

export class StructuredCompletion extends Context.Service<
  StructuredCompletion,
  {
    readonly run: <S extends Schema.ConstraintDecoder<unknown>>(
      input: StructuredCompletionInput<S>
    ) => Effect.Effect<S["Type"], StructuredCompletionError>
    readonly runText: (
      input: TextCompletionInput
    ) => Effect.Effect<string, StructuredCompletionError>
    readonly runTool: <S extends Schema.ConstraintDecoder<unknown>>(
      input: ToolCompletionInput<S>
    ) => Effect.Effect<S["Type"], StructuredCompletionError>
  }
>()("@arden-hq/server/models/StructuredCompletion") {
  static readonly layer: Layer.Layer<
    StructuredCompletion,
    never,
    ModelStore | ModelProviderService | UsageStore
  > = Layer.effect(
    StructuredCompletion,
    Effect.gen(function* () {
      const models = yield* ModelStore
      const modelProvider = yield* ModelProviderService
      const usageStore = yield* UsageStore
      const metered = <A, E>(
        { model }: ResolvedAssignment,
        usage: ModelCallUsage,
        call: (onResponse: (response: CompletionResponse) => void) => Effect.Effect<A, E>
      ): Effect.Effect<A, E> => meteredModelCall(usageStore, { ...usage, modelId: model }, call)

      const resolveAssignment = Effect.fn("StructuredCompletion.resolveAssignment")(function* (
        role: StructuredCompletionRole
      ): Effect.fn.Return<ResolvedAssignment, StructuredCompletionError> {
        const label = roleLabel(role)
        const assignment = yield* (
          role === "helper" ? models.roleSelection(role) : models.selection(role.chat)
        ).pipe(
          Effect.mapError(
            (cause) =>
              new StructuredCompletionError({
                reason: "provider",
                message: `Could not select the ${label} model`,
                cause
              })
          )
        )
        const route = modelProvider.current()
        if (route === undefined || assignment.modelId === null) {
          return yield* new StructuredCompletionError({
            reason: "unavailable",
            message: `The ${label} model is not available`
          })
        }
        return { assignment, label, model: assignment.modelId, route }
      })

      const messages = (
        system: string,
        user: string,
        images: ReadonlyArray<CompletionImage> = []
      ): ReadonlyArray<ChatMessage> => [
        { role: "system", content: withUntrustedDataRule(system) },
        {
          role: "user",
          content:
            images.length === 0
              ? user
              : [
                  ...(user.length === 0 ? [] : [{ type: "text", text: user }]),
                  ...images.map((image) => ({
                    type: "image",
                    media_type: image.mediaType,
                    data: image.data
                  }))
                ]
        }
      ]

      const run = Effect.fn("StructuredCompletion.run")(function* <
        S extends Schema.ConstraintDecoder<unknown>
      >(input: StructuredCompletionInput<S>) {
        const resolved = yield* resolveAssignment(input.role)
        const { label, model, route } = resolved
        const capabilities = yield* Effect.tryPromise({
          try: () => resolveModelCapabilities({ provider: route.provider, model }),
          catch: (cause) =>
            new StructuredCompletionError({
              reason: "provider",
              message: `Could not resolve the ${label} model capabilities`,
              cause
            })
        })
        const unavailableMessage = (effectiveModel: string): string =>
          `The ${label} model (${effectiveModel}) does not support constrained structured output. Choose a model with structured output support in model settings.`
        if (capabilities.structuredOutput === "none") {
          return yield* new StructuredCompletionError({
            reason: "unavailable",
            message: unavailableMessage(model)
          })
        }
        const converted = STRUCTURED_OUTPUT_DIALECTS[route.structuredOutputDialect](input.output)
        const result = yield* metered(resolved, input.usage, (onResponse) =>
          Effect.tryPromise({
            try: () =>
              agentFor(resolved, {
                maxOutputTokens: input.maxOutputTokens,
                toolChoice: ToolChoice.NONE,
                toolset: noTools,
                onResponse: (response) => {
                  onResponse(response)
                  input.onResponse?.(response)
                }
              }).run(messages(input.system, input.user, input.images), {
                ...(input.signal === undefined ? {} : { signal: input.signal }),
                output: {
                  schema: Schema.toStandardSchemaV1(converted.codec),
                  toJsonSchema: () => converted.jsonSchema,
                  name: input.outputName
                }
              }),
            catch: (cause) => {
              if (cause instanceof UnsupportedStructuredOutputError) {
                return new StructuredCompletionError({
                  reason: "unavailable",
                  message: unavailableMessage(cause.model),
                  cause
                })
              }
              if (cause instanceof StructuredOutputError) {
                return new StructuredCompletionError({
                  reason: "invalid_output",
                  message: `The ${label} model returned invalid output`,
                  cause
                })
              }
              return providerFailed(label)(cause)
            }
          })
        )
        if (result.object === undefined) {
          return yield* new StructuredCompletionError({
            reason: "invalid_output",
            message: `The ${label} model did not return structured output`
          })
        }
        return yield* Schema.decodeUnknownEffect(Schema.toType(converted.codec))(result.object, {
          onExcessProperty: "error"
        }).pipe(
          Effect.mapError(
            (cause) =>
              new StructuredCompletionError({
                reason: "invalid_output",
                message: `The ${label} model returned invalid output`,
                cause
              })
          )
        )
      })

      const runText = Effect.fn("StructuredCompletion.runText")(function* (
        input: TextCompletionInput
      ) {
        const resolved = yield* resolveAssignment(input.role)
        const result = yield* metered(resolved, input.usage, (onResponse) =>
          Effect.tryPromise({
            try: async (interrupted) => {
              const agent = agentFor(resolved, {
                maxOutputTokens: input.maxOutputTokens,
                toolChoice: ToolChoice.NONE,
                toolset: noTools,
                onResponse
              })
              const history = messages(input.system, input.user, input.images)
              const options = {
                signal:
                  input.signal === undefined
                    ? interrupted
                    : AbortSignal.any([interrupted, input.signal])
              }
              const { onText } = input
              if (onText === undefined) return agent.run(history, options)
              let result: Result | undefined
              for await (const event of agent.stream(history, options)) {
                if (!("_tag" in event)) result = event
                else if (event._tag === "TextDelta") onText(event.content)
              }
              if (result === undefined) throw new Error("The text stream ended without a result")
              return result
            },
            catch: providerFailed(resolved.label)
          })
        )
        const text = result.text.trim()
        if (text.length === 0 || text.length > input.maxCharacters) {
          return yield* new StructuredCompletionError({
            reason: "invalid_output",
            message: `The ${resolved.label} model returned invalid text`
          })
        }
        return text
      })

      const runTool = Effect.fn("StructuredCompletion.runTool")(function* <
        S extends Schema.ConstraintDecoder<unknown>
      >(input: ToolCompletionInput<S>) {
        const resolved = yield* resolveAssignment(input.role)
        let submitted: { readonly value: S["Type"] } | undefined
        const tool = createTool({
          name: input.result.name,
          description: input.result.description,
          parameters: Schema.toStandardSchemaV1(input.result.schema),
          metadata: {
            display_name: input.result.displayName,
            kind: "tool",
            action: "read",
            source: "_system",
            changes_state: false,
            ends_turn: true
          },
          execute: async (value) => {
            submitted = { value }
            return { result: JSON.stringify(value), preview: input.result.displayName }
          }
        })
        const toolset = createToolset([tool, ...(input.steps?.tools ?? [])], {
          toJsonSchema: (schema: Schema.Constraint): Record<string, unknown> =>
            Schema.toJsonSchemaDocument(schema).schema
        })(undefined)
        const call = (
          onResponse: (response: CompletionResponse) => void | Promise<void>,
          modelRequestMiddlewares: AgentConfigInput["modelRequestMiddlewares"] = []
        ) =>
          Effect.tryPromise({
            try: () =>
              agentFor(resolved, {
                maxOutputTokens: input.maxOutputTokens,
                toolChoice: ToolChoice.REQUIRED,
                toolset,
                onResponse,
                modelRequestMiddlewares: [
                  ...(modelRequestMiddlewares ?? []),
                  ...(input.steps?.modelRequestMiddlewares ?? [])
                ],
                ...(input.steps === undefined
                  ? {}
                  : {
                      worker: { maxToolCalls: input.steps.maxToolCalls },
                      maxIterations: input.steps.maxIterations
                    })
              }).run(messages(input.system, input.user, input.images), {
                ...(input.signal === undefined ? {} : { signal: input.signal })
              }),
            catch: providerFailed(resolved.label)
          })
        const usage = input.usage
        if (usage.kind === "run") {
          const meter = makeModelRequestMeter({
            admit: usage.run.admit,
            signal: input.signal ?? new AbortController().signal,
            report: () => undefined
          })
          yield* call(
            (response) =>
              usage.run.record({ sampleId: meter.sampleId(), usage: responseUsage(response) }),
            [meter.middleware]
          )
        } else {
          yield* metered(resolved, usage, call)
        }
        if (submitted === undefined) {
          return yield* new StructuredCompletionError({
            reason: "invalid_output",
            message: `The ${resolved.label} model did not call its result tool`
          })
        }
        return submitted.value
      })

      return StructuredCompletion.of({ run, runText, runTool })
    })
  )
}
