import type {
  ChatEndpointCheck,
  ChatEndpointSaveResult,
  DecisionBackendState,
  DecisionSource,
  DecisionStatus,
  ModelEndpointCheck,
  ModelEndpointDraft,
  ModelEndpointKind,
  ModelEndpoints as ModelEndpointsView,
  ModelEndpointSaveResult
} from "@arden-hq/protocol/model-endpoints"
import { SEARCH_ENDPOINT_MODEL_ID } from "@arden-hq/protocol/model-endpoints"
import { Context, Duration, Effect, Layer, Schema, Semaphore } from "effect"

import type { CredentialVault } from "../../credentials/vault.js"
import { EmbeddingModels } from "../../embedding/models.js"
import {
  checkEmbeddingEndpoint,
  openAiCompatibleSource
} from "../../embedding/openai-compatible.js"
import { ModelEndpointStore, type StoredEndpoint } from "../../persistence/model-endpoints/store.js"
import type { DecisionEndpoint } from "../decisions/endpoint.js"
import { LocalDecisionEndpoint } from "../decisions/local.js"
import { checkDecisionEndpoint } from "../decisions/service.js"
import { DecisionEndpointSource, type SelectedDecisionEndpoint } from "../decisions/source.js"
import { decisionSiteStatuses } from "../decisions/sites.js"
import { ModelProviderSwitch } from "../provider-switch.js"
import { makeChatEndpoint, type ChatEndpointRequest } from "./chat-service.js"
import { decisionBackendState } from "./decision-backend.js"
import type { EndpointFailureReason } from "./failure.js"
import { nextHealth } from "./health.js"
import { decisionEndpointOf, headersOf, type ResolvedEndpoint } from "./resolved.js"
import { endpointSecrets } from "./secrets.js"
import { view, viewAll } from "./views.js"

export class ModelEndpointsError extends Schema.TaggedError<ModelEndpointsError>()(
  "ModelEndpointsError",
  {
    reason: Schema.Literals(["invalid", "not_found", "storage"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class ModelEndpoints extends Context.Service<
  ModelEndpoints,
  {
    readonly list: () => Effect.Effect<ModelEndpointsView, ModelEndpointsError>
    readonly check: (
      kind: ModelEndpointKind,
      draft: ModelEndpointDraft
    ) => Effect.Effect<ModelEndpointCheck, ModelEndpointsError>
    readonly save: (
      kind: ModelEndpointKind,
      draft: ModelEndpointDraft
    ) => Effect.Effect<ModelEndpointSaveResult, ModelEndpointsError>
    readonly remove: (
      kind: ModelEndpointKind
    ) => Effect.Effect<ModelEndpointsView, ModelEndpointsError>
    readonly checkChat: (
      request: ChatEndpointRequest
    ) => Effect.Effect<ChatEndpointCheck, ModelEndpointsError>
    readonly saveChat: (
      request: ChatEndpointRequest
    ) => Effect.Effect<ChatEndpointSaveResult, ModelEndpointsError>
    readonly removeChat: (id: string) => Effect.Effect<ModelEndpointsView, ModelEndpointsError>
    readonly decisionStatus: () => Effect.Effect<DecisionStatus, ModelEndpointsError>
    readonly setDecisionSource: (
      source: DecisionSource
    ) => Effect.Effect<DecisionStatus, ModelEndpointsError>
  }
>()("@arden-hq/server/models/endpoints/ModelEndpoints") {
  static readonly layer = (
    options: ModelEndpointsOptions
  ): Layer.Layer<
    ModelEndpoints | DecisionEndpointSource,
    never,
    ModelEndpointStore | EmbeddingModels | LocalDecisionEndpoint | ModelProviderSwitch
  > => Layer.effectContext(make(options))
}

export interface ModelEndpointsOptions {
  readonly vault: CredentialVault | undefined
  readonly fetch: typeof globalThis.fetch
  readonly chatFetch: typeof globalThis.fetch
  readonly modelListChanged: () => void
}

const DECISION_TIMEOUT_MS = 3_000
const CHECK_TIMEOUT_MS = 15_000

interface CheckedEndpoint {
  readonly check: ModelEndpointCheck
  readonly dimensions: StoredEndpoint["dimensions"]
}

const make = Effect.fn("ModelEndpoints.make")(function* (options: ModelEndpointsOptions) {
  const store = yield* ModelEndpointStore
  const providerSwitch = yield* ModelProviderSwitch
  const models = yield* EmbeddingModels
  const local = yield* LocalDecisionEndpoint
  const revisions: Record<ModelEndpointKind, number> = { search: 0, decision: 0 }
  const observed = new WeakMap<DecisionEndpoint, number>()
  const credentialLock = yield* Semaphore.make(1)

  const storage = (message: string) => (cause: unknown) =>
    new ModelEndpointsError({ reason: "storage", message, cause })
  const invalid = (message: string) => new ModelEndpointsError({ reason: "invalid", message })
  const notFound = (message: string) => new ModelEndpointsError({ reason: "not_found", message })

  const settings = () =>
    store.settings().pipe(Effect.mapError(storage("Could not read model endpoint settings")))
  const update = (patch: Parameters<ModelEndpointStore["Service"]["updateSettings"]>[0]) =>
    store
      .updateSettings(patch)
      .pipe(Effect.mapError(storage("Could not save model endpoint settings")))

  const {
    read: readSecret,
    write: writeSecret,
    clear: clearSecret,
    readDocument,
    restore: restoreDocument
  } = endpointSecrets(options.vault, storage)

  const reportUnlocked = Effect.fn("ModelEndpoints.report")(function* (
    kind: ModelEndpointKind,
    failure: EndpointFailureReason | undefined,
    revision: number
  ) {
    if (revisions[kind] !== revision) return
    const stored = (yield* settings())[kind]
    if (stored === null) return
    const next = yield* nextHealth(stored.health, failure)
    if (next === undefined) return
    yield* update((current) =>
      current[kind] === null || revisions[kind] !== revision
        ? {}
        : { [kind]: { ...current[kind], health: next } }
    )
  })
  const report = (
    kind: ModelEndpointKind,
    failure: EndpointFailureReason | undefined,
    revision: number
  ) => credentialLock.withPermit(reportUnlocked(kind, failure, revision))
  const reportQuietly = (
    kind: ModelEndpointKind,
    failure: EndpointFailureReason | undefined,
    revision: number
  ) =>
    report(kind, failure, revision).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not record endpoint health", { kind, cause })
      )
    )

  const registerSearch = (stored: StoredEndpoint, secret: string) => {
    const revision = revisions.search
    return stored.dimensions === null
      ? Effect.void
      : models.register(
          openAiCompatibleSource(
            {
              modelId: SEARCH_ENDPOINT_MODEL_ID,
              baseUrl: stored.baseUrl,
              model: stored.model,
              headers: headersOf(stored.auth, secret),
              fetch: options.fetch
            },
            stored.dimensions,
            (failure) => reportQuietly("search", failure?.reason, revision)
          )
        )
  }

  const resolveUnlocked = Effect.fn("ModelEndpoints.resolve")(function* (
    kind: ModelEndpointKind,
    draft: ModelEndpointDraft
  ) {
    if ((kind === "search") !== (draft.format === "openai-embeddings"))
      return yield* invalid(`The ${draft.format} format is not a ${kind} format`)
    if (kind === "search" && draft.input !== "text")
      return yield* invalid("A search endpoint reads text")
    const base = {
      baseUrl: draft.baseUrl,
      format: draft.format,
      model: draft.model,
      input: draft.input
    }
    switch (draft.auth.kind) {
      case "bearer":
        return {
          ...base,
          auth: { kind: "bearer" },
          secret: draft.auth.apiKey
        } satisfies ResolvedEndpoint
      case "header":
        return {
          ...base,
          auth: { kind: "header", name: draft.auth.name },
          secret: draft.auth.value
        } satisfies ResolvedEndpoint
      case "keep": {
        const stored = (yield* settings())[kind]
        const secret = yield* readSecret(kind)
        if (
          stored === null ||
          secret === undefined ||
          new URL(stored.baseUrl).origin !== new URL(draft.baseUrl).origin
        )
          return yield* invalid("No key is saved for this endpoint")
        return { ...base, auth: stored.auth, secret } satisfies ResolvedEndpoint
      }
    }
  })
  const resolve = (kind: ModelEndpointKind, draft: ModelEndpointDraft) =>
    credentialLock.withPermit(resolveUnlocked(kind, draft))

  const runCheck = (kind: ModelEndpointKind, endpoint: ResolvedEndpoint) =>
    kind === "search"
      ? checkEmbeddingEndpoint({
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          headers: headersOf(endpoint.auth, endpoint.secret),
          fetch: options.fetch
        }).pipe(
          Effect.timed,
          Effect.map(([elapsed, dimensions]): CheckedEndpoint => ({
            check: { result: "works", input: "text", ms: Math.round(Duration.toMillis(elapsed)) },
            dimensions
          })),
          Effect.catch((error) =>
            Effect.succeed<CheckedEndpoint>({
              check: { result: error.reason, message: error.message },
              dimensions: null
            })
          )
        )
      : checkDecisionEndpoint(decisionEndpointOf(endpoint, options.fetch, CHECK_TIMEOUT_MS)).pipe(
          Effect.map(({ text, image }): CheckedEndpoint => {
            if (!text.ok)
              return { check: { result: text.reason, message: text.message }, dimensions: null }
            return {
              check: {
                result: "works",
                input: image !== "not_declared" && image.ok ? "text+image" : "text",
                ms: text.ms
              },
              dimensions: null
            }
          })
        )

  const check = Effect.fn("ModelEndpoints.check")(function* (
    kind: ModelEndpointKind,
    draft: ModelEndpointDraft
  ) {
    const revision = revisions[kind]
    const endpoint = yield* resolve(kind, draft)
    const result = (yield* runCheck(kind, endpoint)).check
    const stored = (yield* settings())[kind]
    const sameAsSaved =
      draft.auth.kind === "keep" &&
      stored !== null &&
      stored.baseUrl === draft.baseUrl &&
      stored.format === draft.format &&
      stored.model === draft.model
    if (sameAsSaved)
      yield* report(kind, result.result === "works" ? undefined : result.result, revision)
    return result
  })

  const save = Effect.fn("ModelEndpoints.save")(function* (
    kind: ModelEndpointKind,
    draft: ModelEndpointDraft
  ) {
    const endpoint = yield* resolve(kind, draft)
    const { check: result, dimensions } = yield* runCheck(kind, endpoint)
    if (result.result !== "works") return result
    const stored: StoredEndpoint = {
      baseUrl: endpoint.baseUrl,
      format: endpoint.format,
      model: endpoint.model,
      input: result.input,
      auth: endpoint.auth,
      dimensions,
      health: { state: "works" }
    }
    yield* credentialLock.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (draft.auth.kind === "keep") {
            const latest = yield* resolveUnlocked(kind, draft)
            if (
              latest.secret !== endpoint.secret ||
              latest.auth.kind !== endpoint.auth.kind ||
              (latest.auth.kind === "header" &&
                endpoint.auth.kind === "header" &&
                latest.auth.name !== endpoint.auth.name)
            )
              return yield* invalid("The saved endpoint key changed during Check")
            yield* update({ [kind]: stored })
          } else {
            const previous = yield* readDocument(kind)
            const previousStored = (yield* settings())[kind]
            yield* update({ [kind]: null })
            revisions[kind] += 1
            yield* writeSecret(kind, endpoint.secret).pipe(
              Effect.andThen(update({ [kind]: stored })),
              Effect.catch((cause) =>
                restoreDocument(kind, previous).pipe(
                  Effect.andThen(update({ [kind]: previousStored })),
                  Effect.andThen(Effect.fail(cause))
                )
              )
            )
          }
          if (draft.auth.kind === "keep") revisions[kind] += 1
          if (kind === "search") yield* registerSearch(stored, endpoint.secret)
        })
      )
    )
    return { result: "saved", endpoint: view(kind, stored) } satisfies ModelEndpointSaveResult
  })

  const list = () => settings().pipe(Effect.map(viewAll))

  const remove = Effect.fn("ModelEndpoints.remove")(function* (kind: ModelEndpointKind) {
    const next = yield* credentialLock.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const previous = yield* readDocument(kind)
          const previousStored = (yield* settings())[kind]
          const next = yield* update({ [kind]: null })
          revisions[kind] += 1
          yield* clearSecret(kind).pipe(
            Effect.catch((cause) =>
              restoreDocument(kind, previous).pipe(
                Effect.andThen(update({ [kind]: previousStored })),
                Effect.andThen(Effect.fail(cause))
              )
            )
          )
          if (kind === "search") yield* models.unregister(SEARCH_ENDPOINT_MODEL_ID)
          return next
        })
      )
    )
    return viewAll(next)
  })

  const decisionStatus = Effect.fn("ModelEndpoints.decisionStatus")(function* () {
    const current = yield* settings()
    const backend: DecisionBackendState = yield* decisionBackendState(current, local)
    return {
      source: current.decisionSource,
      backend,
      sites: decisionSiteStatuses(backend)
    } satisfies DecisionStatus
  })

  const setDecisionSource = (source: DecisionSource) =>
    credentialLock
      .withPermit(update({ decisionSource: source }))
      .pipe(Effect.andThen(decisionStatus()))

  const current = Effect.fn("DecisionEndpointSource.current")(function* () {
    const { revision, saved, secret } = yield* credentialLock.withPermit(
      Effect.gen(function* () {
        const saved = yield* settings()
        const secret =
          saved.decisionSource === "endpoint" && saved.decision !== null
            ? yield* readSecret("decision")
            : undefined
        return { revision: revisions.decision, saved, secret }
      })
    )
    switch (saved.decisionSource) {
      case "off":
        return undefined
      case "local": {
        const endpoint = yield* local.endpoint()
        return endpoint === undefined
          ? undefined
          : ({ origin: "local", endpoint } satisfies SelectedDecisionEndpoint)
      }
      case "endpoint": {
        const stored = saved.decision
        if (stored === null) return undefined
        if (secret === undefined) return undefined
        const endpoint = decisionEndpointOf(
          { ...stored, secret },
          options.fetch,
          DECISION_TIMEOUT_MS
        )
        observed.set(endpoint, revision)
        return { origin: "endpoint", endpoint } satisfies SelectedDecisionEndpoint
      }
    }
  })

  const chat = yield* makeChatEndpoint({
    fetch: options.chatFetch,
    lock: credentialLock,
    settings,
    update,
    invalid,
    notFound,
    secrets: {
      read: (id) => readSecret({ chat: id }),
      readDocument: (id) => readDocument({ chat: id }),
      write: (id, secret) => writeSecret({ chat: id }, secret),
      restore: (id, value) => restoreDocument({ chat: id }, value)
    },
    nextHealth,
    switch: providerSwitch,
    listChanged: options.modelListChanged,
    newId: () => crypto.randomUUID()
  })
  yield* chat
    .start()
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("The saved model servers could not be loaded", { cause })
      )
    )

  yield* Effect.gen(function* () {
    const stored = (yield* settings()).search
    if (stored === null) return
    const secret = yield* readSecret("search")
    if (secret !== undefined) yield* registerSearch(stored, secret)
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("The saved search endpoint could not be loaded", { cause })
    )
  )

  return Context.make(
    ModelEndpoints,
    ModelEndpoints.of({
      list,
      check,
      save,
      remove,
      checkChat: chat.check,
      saveChat: chat.save,
      removeChat: (id) => chat.remove(id).pipe(Effect.map(viewAll)),
      decisionStatus,
      setDecisionSource
    })
  ).pipe(
    Context.add(
      DecisionEndpointSource,
      DecisionEndpointSource.of({
        current: () =>
          current().pipe(
            Effect.catch((cause) =>
              Effect.logWarning("The decision endpoint could not be read; the Helper decides", {
                cause
              }).pipe(Effect.as(undefined))
            )
          ),
        report: (selected, failure) => {
          const revision = observed.get(selected.endpoint)
          return selected.origin === "endpoint" && revision !== undefined
            ? reportQuietly("decision", failure, revision)
            : Effect.void
        }
      })
    )
  )
})
