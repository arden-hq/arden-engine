import type {
  ChatEndpointCheck,
  ChatEndpointDraft,
  ChatEndpointSaveResult,
  ChatModelEndpoint
} from "@arden-hq/protocol/model-endpoints"
import { Effect, type Semaphore } from "effect"

import type {
  EndpointHealth,
  ModelEndpointSettings,
  ModelEndpointSettingsPatch,
  StoredChatEndpoint
} from "../../persistence/model-endpoints/store.js"
import type { ModelProviderSwitch } from "../provider-switch.js"
import {
  chatGroup,
  checkChatEndpoint,
  discoverChatEndpoint,
  serverModels,
  type ChatEndpointTarget
} from "./chat.js"
import type { EndpointFailureReason } from "./failure.js"
import type { ModelEndpointsError } from "./service.js"

/**
 * The saved model server inside the endpoint service: Check, save, remove,
 * and keeping its models in the model list. It shares the service's key
 * vault, settings document, lock and health rule (`nextHealth`), so a model
 * server is "Unreachable" and back exactly as a search or decision endpoint is.
 *
 * When it is re-asked: at start (discovery only, in the background: the saved
 * list is installed first, so a stopped server never holds up start), at
 * every Check of the saved server, and by every chat request to its models.
 * There is no polling, as for the other endpoints.
 */
export interface ChatEndpointDeps {
  readonly fetch: typeof globalThis.fetch
  readonly lock: Semaphore.Semaphore
  readonly settings: () => Effect.Effect<ModelEndpointSettings, ModelEndpointsError>
  readonly update: (
    patch:
      | ModelEndpointSettingsPatch
      | ((current: ModelEndpointSettings) => ModelEndpointSettingsPatch)
  ) => Effect.Effect<ModelEndpointSettings, ModelEndpointsError>
  readonly invalid: (message: string) => ModelEndpointsError
  readonly secrets: {
    readonly read: () => Effect.Effect<string | undefined, ModelEndpointsError>
    readonly readDocument: () => Effect.Effect<unknown | null, ModelEndpointsError>
    readonly write: (secret: string) => Effect.Effect<void, ModelEndpointsError>
    readonly restore: (value: unknown | null) => Effect.Effect<void, ModelEndpointsError>
  }
  readonly nextHealth: (
    health: EndpointHealth,
    failure: EndpointFailureReason | undefined
  ) => Effect.Effect<EndpointHealth | undefined>
  readonly switch: ModelProviderSwitch["Service"]
  /** Tells the host the model list changed, as a ChatGPT sign-in does. */
  readonly listChanged: () => void
}

export const makeChatEndpoint = Effect.fn("ChatEndpoint.make")(function* (deps: ChatEndpointDeps) {
  let revision = 0

  const resolveUnlocked = Effect.fn("ChatEndpoint.resolve")(function* (draft: ChatEndpointDraft) {
    const base = { baseUrl: draft.baseUrl, fetch: deps.fetch }
    const shape =
      draft.service === "llama.cpp"
        ? { service: draft.service }
        : { service: draft.service, model: draft.model }
    switch (draft.auth.kind) {
      case "none":
        return { ...shape, ...base, key: undefined } satisfies ChatEndpointTarget
      case "bearer":
        return { ...shape, ...base, key: draft.auth.apiKey } satisfies ChatEndpointTarget
      case "keep": {
        const stored = (yield* deps.settings()).chat
        const key = yield* deps.secrets.read()
        if (
          stored === null ||
          stored.auth.kind !== "bearer" ||
          key === undefined ||
          new URL(stored.baseUrl).origin !== new URL(draft.baseUrl).origin
        )
          return yield* deps.invalid("No key is saved for this model server")
        return { ...shape, ...base, key } satisfies ChatEndpointTarget
      }
    }
  })
  const resolve = (draft: ChatEndpointDraft) => deps.lock.withPermit(resolveUnlocked(draft))

  const reportUnlocked = Effect.fn("ChatEndpoint.report")(function* (
    failure: EndpointFailureReason | undefined,
    seen: number
  ) {
    if (revision !== seen) return
    const stored = (yield* deps.settings()).chat
    if (stored === null) return
    const next = yield* deps.nextHealth(stored.health, failure)
    if (next === undefined) return
    yield* deps.update((current) =>
      current.chat === null || revision !== seen ? {} : { chat: { ...current.chat, health: next } }
    )
  })
  const report = (failure: EndpointFailureReason | undefined, seen: number) =>
    deps.lock.withPermit(reportUnlocked(failure, seen))
  const reportQuietly = (failure: EndpointFailureReason | undefined, seen: number) =>
    report(failure, seen).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not record the model server's health", { cause })
      )
    )

  /** Puts the saved server's models in the list; requests report to this revision. */
  const install = (stored: StoredChatEndpoint | null, key: string | undefined) => {
    const seen = revision
    return deps.switch
      .replaceServer(
        stored === null
          ? undefined
          : serverModels({
              stored,
              key,
              fetch: deps.fetch,
              report: (failure) => void Effect.runFork(reportQuietly(failure, seen))
            })
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logError("The model server's models could not be listed", { cause })
        )
      )
  }

  const check = Effect.fn("ChatEndpoint.check")(function* (draft: ChatEndpointDraft) {
    const seen = revision
    const target = yield* resolve(draft)
    const result = yield* Effect.promise(() => checkChatEndpoint(target))
    const stored = (yield* deps.settings()).chat
    if (stored !== null && isSaved(stored, draft)) yield* report(healthOf(result.result), seen)
    return viewCheck(draft, result)
  })

  const save = Effect.fn("ChatEndpoint.save")(function* (draft: ChatEndpointDraft) {
    const target = yield* resolve(draft)
    const result = yield* Effect.promise(() => checkChatEndpoint(target))
    if (result.result !== "works") return result satisfies ChatEndpointSaveResult
    const stored: StoredChatEndpoint = {
      service: draft.service,
      baseUrl: draft.baseUrl,
      auth: target.key === undefined ? { kind: "none" } : { kind: "bearer" },
      models: result.models,
      skipped: result.skipped,
      health: { state: "works" }
    }
    yield* deps.lock.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (draft.auth.kind === "keep") {
            const latest = yield* resolveUnlocked(draft)
            if (latest.key !== target.key)
              return yield* deps.invalid("The saved key changed during Check")
            yield* deps.update({ chat: stored })
          } else yield* replaceSaved(stored, target.key)
          revision += 1
          yield* install(stored, target.key)
        })
      )
    )
    deps.listChanged()
    return { result: "saved", endpoint: view(stored) } satisfies ChatEndpointSaveResult
  })

  const remove = Effect.fn("ChatEndpoint.remove")(function* () {
    const next = yield* deps.lock.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const next = yield* replaceSaved(null, undefined)
          revision += 1
          yield* install(null, undefined)
          return next
        })
      )
    )
    deps.listChanged()
    return next
  })

  /**
   * Writes the saved server and its key together: a failure puts back both.
   * The vault is touched only when a key is or was saved, so a server without
   * one is saved where no vault exists (a configured server, a test).
   */
  const replaceSaved = Effect.fn("ChatEndpoint.replaceSaved")(function* (
    stored: StoredChatEndpoint | null,
    key: string | undefined
  ) {
    const previousStored = (yield* deps.settings()).chat
    if (key === undefined && previousStored?.auth.kind !== "bearer")
      return yield* deps.update({ chat: stored })
    const previous = yield* deps.secrets.readDocument()
    yield* deps.update({ chat: null })
    const written = key === undefined ? deps.secrets.restore(null) : deps.secrets.write(key)
    return yield* written.pipe(
      Effect.andThen(deps.update({ chat: stored })),
      Effect.catch((cause) =>
        deps.secrets
          .restore(previous)
          .pipe(
            Effect.andThen(deps.update({ chat: previousStored })),
            Effect.andThen(Effect.fail(cause))
          )
      )
    )
  })

  /**
   * At start: the saved list goes in at once, from what discovery last
   * reported. Then the server is asked again in the background; a working
   * answer refreshes the list (a llama.cpp server restarted with other
   * models), a stopped server is marked unreachable and keeps its models.
   */
  const start = Effect.fn("ChatEndpoint.start")(function* () {
    const stored = (yield* deps.settings()).chat
    if (stored === null) return
    const key = stored.auth.kind === "bearer" ? yield* deps.secrets.read() : undefined
    if (stored.auth.kind === "bearer" && key === undefined)
      yield* Effect.logWarning("The model server's key is missing; its requests will be refused")
    yield* install(stored, key)
    yield* Effect.forkScoped(reprobe(stored, key, revision))
  })

  const reprobe = (stored: StoredChatEndpoint, key: string | undefined, seen: number) =>
    Effect.gen(function* () {
      const found = yield* Effect.promise(() => discoverChatEndpoint(targetOf(stored, key, deps)))
      if (found.result === "unreachable" || found.result === "key_refused")
        return yield* report(found.result, seen)
      // Anything else (its models now refused, say) keeps the saved list and
      // health: the next Check says what changed, and Save replaces the list.
      if (found.result !== "works")
        return yield* Effect.logWarning("The model server no longer offers its saved models", {
          result: found.result
        })
      const changed =
        JSON.stringify([found.models, found.skipped]) !==
        JSON.stringify([stored.models, stored.skipped])
      const refreshed = yield* deps.lock.withPermit(
        Effect.gen(function* () {
          const current = (yield* deps.settings()).chat
          if (revision !== seen || current === null) return undefined
          const health = (yield* deps.nextHealth(current.health, undefined)) ?? current.health
          const next = { ...current, models: found.models, skipped: found.skipped, health }
          yield* deps.update({ chat: next })
          if (changed) yield* install(next, key)
          return next
        })
      )
      if (refreshed !== undefined && changed) deps.listChanged()
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not ask the model server again", { cause }))
    )

  return { check, save, remove, start }
})

/** A draft that names the saved server and its saved key, so its Check is the saved one's health. */
const isSaved = (stored: StoredChatEndpoint, draft: ChatEndpointDraft): boolean =>
  stored.service === draft.service &&
  stored.baseUrl === draft.baseUrl &&
  (draft.service === "llama.cpp" || stored.models[0]?.id === draft.model) &&
  (draft.auth.kind === "keep" || (draft.auth.kind === "none" && stored.auth.kind === "none"))

/** What a Check says about a saved server's health; undefined says it works. */
const healthOf = (result: ChatEndpointCheck["result"]): EndpointFailureReason | undefined => {
  switch (result) {
    case "works":
      return undefined
    case "key_refused":
    case "unreachable":
    case "wrong_format":
      return result
    case "address_refused":
    case "no_tool_calls":
    case "window_too_small":
    case "window_unknown":
    case "model_missing":
    case "model_taken":
      return "wrong_format"
  }
}

const targetOf = (
  stored: StoredChatEndpoint,
  key: string | undefined,
  deps: Pick<ChatEndpointDeps, "fetch">
): ChatEndpointTarget => {
  const base = { baseUrl: stored.baseUrl, key, fetch: deps.fetch }
  const named = stored.models[0]?.id
  return stored.service === "llama.cpp" || named === undefined
    ? { ...base, service: "llama.cpp" }
    : { ...base, service: stored.service, model: named }
}

const viewCheck = (
  draft: ChatEndpointDraft,
  result: Awaited<ReturnType<typeof checkChatEndpoint>>
): ChatEndpointCheck =>
  result.result === "works"
    ? {
        result: "works",
        host: new URL(draft.baseUrl).host,
        group: chatGroup(draft.service, draft.baseUrl).name,
        models: result.models.map(modelView),
        skipped: result.skipped,
        ms: result.ms
      }
    : result

const modelView = (model: StoredChatEndpoint["models"][number]) => ({
  id: model.id,
  contextWindow: model.window,
  imageInput: model.compat.imageInput === true
})

export const view = (stored: StoredChatEndpoint): ChatModelEndpoint => ({
  kind: "chat",
  service: stored.service,
  baseUrl: stored.baseUrl,
  host: new URL(stored.baseUrl).host,
  group: chatGroup(stored.service, stored.baseUrl).name,
  auth: stored.auth,
  models: stored.models.map(modelView),
  skipped: stored.skipped,
  health: stored.health
})
