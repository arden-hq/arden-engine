import type {
  DecisionBackendState,
  DecisionSource,
  DecisionStatus,
  ModelEndpoint,
  ModelEndpointCheck,
  ModelEndpointDraft,
  ModelEndpointKind,
  ModelEndpoints as ModelEndpointsView,
  ModelEndpointSaveResult
} from "@arden-hq/protocol/model-endpoints"
import { SEARCH_ENDPOINT_MODEL_ID } from "@arden-hq/protocol/model-endpoints"
import { Context, DateTime, Duration, Effect, Layer, Redacted, Schema, Semaphore } from "effect"

import {
  type CredentialVault,
  decodeVaultValue,
  readSecureDocument,
  requireVault,
  type SecureDocumentTarget,
  vaultOperation,
  writeSecureDocument
} from "../../credentials/vault.js"
import { EmbeddingModels } from "../../embedding/models.js"
import {
  checkEmbeddingEndpoint,
  openAiCompatibleSource
} from "../../embedding/openai-compatible.js"
import {
  type EndpointHealth,
  ModelEndpointStore,
  type ModelEndpointSettings,
  type StoredEndpoint
} from "../../persistence/model-endpoints/store.js"
import type { DecisionEndpoint } from "../decisions/endpoint.js"
import { LocalDecisionEndpoint } from "../decisions/local.js"
import { checkDecisionEndpoint } from "../decisions/service.js"
import { DecisionEndpointSource, type SelectedDecisionEndpoint } from "../decisions/source.js"
import { decisionSiteStatuses } from "../decisions/sites.js"
import { type EndpointFailureReason, runtimeFailure } from "./failure.js"

export class ModelEndpointsError extends Schema.TaggedError<ModelEndpointsError>()(
  "ModelEndpointsError",
  {
    reason: Schema.Literals(["invalid", "storage"] as const),
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
    readonly decisionStatus: () => Effect.Effect<DecisionStatus, ModelEndpointsError>
    readonly setDecisionSource: (
      source: DecisionSource
    ) => Effect.Effect<DecisionStatus, ModelEndpointsError>
  }
>()("@arden-hq/server/models/endpoints/ModelEndpoints") {
  static readonly layer = (options: {
    readonly vault: CredentialVault | undefined
    readonly fetch: typeof globalThis.fetch
  }): Layer.Layer<
    ModelEndpoints | DecisionEndpointSource,
    never,
    ModelEndpointStore | EmbeddingModels | LocalDecisionEndpoint
  > => Layer.effectContext(make(options))
}

const DECISION_TIMEOUT_MS = 3_000
const CHECK_TIMEOUT_MS = 15_000

const secretTarget = (kind: ModelEndpointKind): SecureDocumentTarget => ({
  documentKey: `model-endpoint:${kind}`,
  binding: `model-endpoint:${kind}:v1`
})

const SecretDocumentSchema = Schema.Struct({ secret: Schema.NonEmptyString })

interface ResolvedEndpoint extends Omit<StoredEndpoint, "dimensions" | "health"> {
  readonly secret: string
}

const make = Effect.fn("ModelEndpoints.make")(function* (options: {
  readonly vault: CredentialVault | undefined
  readonly fetch: typeof globalThis.fetch
}) {
  const store = yield* ModelEndpointStore
  const models = yield* EmbeddingModels
  const local = yield* LocalDecisionEndpoint
  const revisions: Record<ModelEndpointKind, number> = { search: 0, decision: 0 }
  const observed = new WeakMap<DecisionEndpoint, number>()
  const credentialLock = yield* Semaphore.make(1)

  const storage = (message: string) => (cause: unknown) =>
    new ModelEndpointsError({ reason: "storage", message, cause })
  const invalid = (message: string) => new ModelEndpointsError({ reason: "invalid", message })

  const settings = () =>
    store.settings().pipe(Effect.mapError(storage("Could not read model endpoint settings")))
  const update = (patch: Parameters<ModelEndpointStore["Service"]["updateSettings"]>[0]) =>
    store
      .updateSettings(patch)
      .pipe(Effect.mapError(storage("Could not save model endpoint settings")))

  const readSecret = (kind: ModelEndpointKind) =>
    Effect.tryPromise({
      try: async () => {
        const value = await readSecureDocument(options.vault, secretTarget(kind))
        if (value === null) return undefined
        const decoded = await decodeVaultValue(
          SecretDocumentSchema,
          value,
          "The saved endpoint key is unreadable"
        )
        return decoded.secret
      },
      catch: storage("Could not read the endpoint key")
    })
  const writeSecret = (kind: ModelEndpointKind, secret: string) =>
    Effect.tryPromise({
      try: () => writeSecureDocument(options.vault, secretTarget(kind), { secret }),
      catch: storage("Could not save the endpoint key")
    })
  const clearSecret = (kind: ModelEndpointKind) =>
    Effect.tryPromise({
      try: () =>
        vaultOperation("Could not delete the endpoint key", () =>
          requireVault(options.vault).clearDocument(secretTarget(kind))
        ),
      catch: storage("Could not delete the endpoint key")
    })
  const readDocument = (kind: ModelEndpointKind) =>
    Effect.tryPromise({
      try: () => readSecureDocument(options.vault, secretTarget(kind)),
      catch: storage("Could not read the endpoint key")
    })
  const restoreDocument = (kind: ModelEndpointKind, value: unknown | null) =>
    value === null
      ? clearSecret(kind)
      : Effect.tryPromise({
          try: () => writeSecureDocument(options.vault, secretTarget(kind), value),
          catch: storage("Could not restore the endpoint key")
        })

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
          Effect.map(([elapsed, dimensions]): ModelEndpointCheck => ({
            result: "works",
            input: "text",
            dimensions,
            ms: Math.round(Duration.toMillis(elapsed))
          })),
          Effect.catch((error) =>
            Effect.succeed<ModelEndpointCheck>({ result: error.reason, message: error.message })
          )
        )
      : checkDecisionEndpoint(decisionEndpointOf(endpoint, options.fetch, CHECK_TIMEOUT_MS)).pipe(
          Effect.map(({ text, image }): ModelEndpointCheck => {
            if (!text.ok) return { result: text.reason, message: text.message }
            return {
              result: "works",
              input: image !== "not_declared" && image.ok ? "text+image" : "text",
              dimensions: null,
              ms: text.ms
            }
          })
        )

  const check = Effect.fn("ModelEndpoints.check")(function* (
    kind: ModelEndpointKind,
    draft: ModelEndpointDraft
  ) {
    const revision = revisions[kind]
    const endpoint = yield* resolve(kind, draft)
    const result = yield* runCheck(kind, endpoint)
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
    const result = yield* runCheck(kind, endpoint)
    if (result.result !== "works") return result
    const stored: StoredEndpoint = {
      baseUrl: endpoint.baseUrl,
      format: endpoint.format,
      model: endpoint.model,
      input: result.input,
      auth: endpoint.auth,
      dimensions: result.dimensions,
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

  const backendState = Effect.fn("ModelEndpoints.backendState")(function* (
    current: ModelEndpointSettings
  ) {
    switch (current.decisionSource) {
      case "off":
        return { state: "off" } satisfies DecisionBackendState
      case "local": {
        const endpoint = yield* local.endpoint()
        return endpoint === undefined
          ? ({ state: "unavailable", reason: "no_local_model" } satisfies DecisionBackendState)
          : ({
              state: "ready",
              model: endpoint.model,
              input: endpoint.input
            } satisfies DecisionBackendState)
      }
      case "endpoint": {
        const stored = current.decision
        if (stored === null)
          return { state: "unavailable", reason: "no_endpoint" } satisfies DecisionBackendState
        return stored.health.state === "failing"
          ? ({
              state: "failing",
              model: stored.model,
              input: stored.input,
              reason: stored.health.reason,
              since: stored.health.since
            } satisfies DecisionBackendState)
          : ({
              state: "ready",
              model: stored.model,
              input: stored.input
            } satisfies DecisionBackendState)
      }
    }
  })

  const decisionStatus = Effect.fn("ModelEndpoints.decisionStatus")(function* () {
    const current = yield* settings()
    const backend: DecisionBackendState = yield* backendState(current)
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
    ModelEndpoints.of({ list, check, save, remove, decisionStatus, setDecisionSource })
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

const nextHealth = (
  health: EndpointHealth,
  failure: EndpointFailureReason | undefined
): Effect.Effect<EndpointHealth | undefined> => {
  if (failure === undefined)
    return Effect.succeed(health.state === "works" ? undefined : { state: "works" })
  const reason = runtimeFailure(failure)
  if (health.state === "failing" && health.reason === reason) return Effect.succeed(undefined)
  return DateTime.now.pipe(
    Effect.map((now): EndpointHealth => ({
      state: "failing",
      reason,
      since: DateTime.formatIso(now),
      message:
        reason === "key_refused" ? "The service refused the key" : "The endpoint stopped answering"
    }))
  )
}

const headersOf = (auth: StoredEndpoint["auth"], secret: string): Record<string, string> =>
  auth.kind === "bearer" ? { authorization: `Bearer ${secret}` } : { [auth.name]: secret }

const decisionEndpointOf = (
  endpoint: ResolvedEndpoint,
  fetch: typeof globalThis.fetch,
  timeoutMs: number
): DecisionEndpoint => ({
  id: "endpoint",
  format: {
    "openai-decisions": "decisions",
    "openrouter-decisions": "openrouter-decisions",
    systemone: "systemone",
    "openai-embeddings": "systemone"
  }[endpoint.format] as DecisionEndpoint["format"],
  baseUrl: endpoint.baseUrl,
  auth:
    endpoint.auth.kind === "bearer"
      ? { kind: "bearer", apiKey: Redacted.make(endpoint.secret) }
      : { kind: "header", name: endpoint.auth.name, value: Redacted.make(endpoint.secret) },
  model: endpoint.model,
  input: endpoint.input,
  timeoutMs,
  fetch
})

const view = (kind: ModelEndpointKind, stored: StoredEndpoint): ModelEndpoint => ({
  kind,
  ...stored
})

const viewAll = (saved: ModelEndpointSettings): ModelEndpointsView => ({
  search: saved.search === null ? null : view("search", saved.search),
  decision: saved.decision === null ? null : view("decision", saved.decision)
})
