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
  chatGroups,
  checkChatEndpoint,
  discoverChatEndpoint,
  serverModels,
  takenFailure,
  untaken,
  type ChatEndpointTarget,
  type ChatServerIdentity,
  type TakenModels
} from "./chat.js"
import type { EndpointFailureReason } from "./failure.js"
import type { ModelEndpointsError } from "./service.js"

/**
 * The saved model servers inside the endpoint service: Check, add, replace,
 * remove, and keeping their models in the model list. They share the
 * service's key vault, settings document, lock and health rule
 * (`nextHealth`), so a model server is "Unreachable" and back exactly as a
 * search or decision endpoint is. Each server has its own key, health and
 * revision; one changing never touches another's.
 *
 * When a server is re-asked: at start (discovery only, in the background:
 * the saved lists are installed first, so a stopped server never holds up
 * start), at every Check of its edit, and by every chat request to its
 * models. There is no polling, as for the other endpoints.
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
  readonly notFound: (message: string) => ModelEndpointsError
  /** Each server's key, in the vault under its id. */
  readonly secrets: {
    readonly read: (id: string) => Effect.Effect<string | undefined, ModelEndpointsError>
    readonly readDocument: (id: string) => Effect.Effect<unknown | null, ModelEndpointsError>
    readonly write: (id: string, secret: string) => Effect.Effect<void, ModelEndpointsError>
    readonly restore: (
      id: string,
      value: unknown | null
    ) => Effect.Effect<void, ModelEndpointsError>
  }
  readonly nextHealth: (
    health: EndpointHealth,
    failure: EndpointFailureReason | undefined
  ) => Effect.Effect<EndpointHealth | undefined>
  readonly switch: ModelProviderSwitch["Service"]
  /** Tells the host the model list changed, as a ChatGPT sign-in does. */
  readonly listChanged: () => void
  /** A new server's id. */
  readonly newId: () => string
}

/** A Check or save: of a new server, or of an edit of the saved one `editing` names. */
export interface ChatEndpointRequest {
  readonly draft: ChatEndpointDraft
  readonly editing: string | undefined
}

export const makeChatEndpoint = Effect.fn("ChatEndpoint.make")(function* (deps: ChatEndpointDeps) {
  /** Bumped when a server is replaced or removed: its old adapters' reports are then ignored. */
  const revisions = new Map<string, number>()
  const revisionOf = (id: string) => revisions.get(id) ?? 0
  /** The keys the installed adapters use, read once at start and set by each save. */
  const keys = new Map<string, string>()

  const saved = Effect.fn("ChatEndpoint.saved")(function* () {
    return (yield* deps.settings()).chat
  })
  const findSaved = Effect.fn("ChatEndpoint.findSaved")(function* (id: string) {
    const stored = (yield* saved()).find((server) => server.id === id)
    if (stored === undefined) return yield* deps.notFound("No model server is saved with this id")
    return stored
  })

  const resolveUnlocked = Effect.fn("ChatEndpoint.resolve")(function* (
    request: ChatEndpointRequest
  ) {
    const { draft, editing } = request
    const base = { baseUrl: draft.baseUrl, fetch: deps.fetch }
    const shape =
      draft.service === "llama.cpp"
        ? { service: draft.service }
        : { service: draft.service, models: draft.models }
    const stored = editing === undefined ? undefined : yield* findSaved(editing)
    switch (draft.auth.kind) {
      case "none":
        return { ...shape, ...base, key: undefined } satisfies ChatEndpointTarget
      case "bearer":
        return { ...shape, ...base, key: draft.auth.apiKey } satisfies ChatEndpointTarget
      case "keep": {
        const key = stored === undefined ? undefined : yield* deps.secrets.read(stored.id)
        if (
          stored === undefined ||
          stored.auth.kind !== "bearer" ||
          key === undefined ||
          new URL(stored.baseUrl).origin !== new URL(draft.baseUrl).origin
        )
          return yield* deps.invalid("No key is saved for this model server")
        return { ...shape, ...base, key } satisfies ChatEndpointTarget
      }
    }
  })
  const resolve = (request: ChatEndpointRequest) => deps.lock.withPermit(resolveUnlocked(request))

  const reportUnlocked = Effect.fn("ChatEndpoint.report")(function* (
    id: string,
    failure: EndpointFailureReason | undefined,
    seen: number
  ) {
    if (revisionOf(id) !== seen) return
    const stored = (yield* saved()).find((server) => server.id === id)
    if (stored === undefined) return
    const next = yield* deps.nextHealth(stored.health, failure)
    if (next === undefined) return
    yield* deps.update((current) =>
      revisionOf(id) !== seen
        ? {}
        : {
            chat: current.chat.map((server) =>
              server.id === id ? { ...server, health: next } : server
            )
          }
    )
  })
  const report = (id: string, failure: EndpointFailureReason | undefined, seen: number) =>
    deps.lock.withPermit(reportUnlocked(id, failure, seen))
  const reportQuietly = (id: string, failure: EndpointFailureReason | undefined, seen: number) =>
    report(id, failure, seen).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not record a model server's health", { id, cause })
      )
    )

  /** Puts every saved server's models in the list; each reports to its current revision. */
  const install = (servers: ReadonlyArray<StoredChatEndpoint>) => {
    const groups = chatGroups(servers)
    return deps.switch
      .replaceServers(
        servers.map((stored) => {
          const seen = revisionOf(stored.id)
          return serverModels({
            stored,
            group: groupOf(groups, stored.id),
            key: keys.get(stored.id),
            fetch: deps.fetch,
            report: (failure) => void Effect.runFork(reportQuietly(stored.id, failure, seen))
          })
        })
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logError("The model servers' models could not be listed", { cause })
        )
      )
  }

  const check = Effect.fn("ChatEndpoint.check")(function* (request: ChatEndpointRequest) {
    const { draft, editing } = request
    const seen = editing === undefined ? 0 : revisionOf(editing)
    const target = yield* resolve(request)
    const servers = yield* saved()
    const result = yield* Effect.promise(() =>
      checkChatEndpoint(target, { taken: takenBy(servers, editing) })
    )
    const stored = servers.find((server) => server.id === editing)
    if (stored !== undefined && isSaved(stored, draft))
      yield* report(stored.id, healthOf(result.result), seen)
    if (result.result !== "works") return result
    const checked = identity(draft, editing)
    return {
      result: "works",
      host: new URL(draft.baseUrl).host,
      group: groupOf(chatGroups(placed(servers, checked)), checked.id).name,
      models: result.models.map(modelView),
      skipped: result.skipped,
      ms: result.ms
    } satisfies ChatEndpointCheck
  })

  const save = Effect.fn("ChatEndpoint.save")(function* (request: ChatEndpointRequest) {
    const { draft, editing } = request
    const target = yield* resolve(request)
    const servers = yield* saved()
    const result = yield* Effect.promise(() =>
      checkChatEndpoint(target, { taken: takenBy(servers, editing) })
    )
    if (result.result !== "works") return result satisfies ChatEndpointSaveResult
    const id = editing ?? deps.newId()
    const stored: StoredChatEndpoint = {
      id,
      service: draft.service,
      baseUrl: draft.baseUrl,
      auth: target.key === undefined ? { kind: "none" } : { kind: "bearer" },
      models: result.models,
      skipped: result.skipped,
      health: { state: "works" }
    }
    const written = yield* deps.lock.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (editing !== undefined) yield* findSaved(editing)
          // Another save may have taken a model while this one was checked.
          const clash = takenFailure(
            stored.models.map((model) => model.id),
            takenBy(yield* saved(), editing)
          )
          if (clash !== undefined) return { kind: "refused", clash } as const
          if (draft.auth.kind === "keep") {
            const latest = yield* resolveUnlocked(request)
            if (latest.key !== target.key)
              return yield* deps.invalid("The saved key changed during Check")
            yield* deps.update((current) => ({ chat: placed(current.chat, stored) }))
          } else yield* replaceSaved(id, stored, target.key)
          if (target.key === undefined) keys.delete(id)
          else keys.set(id, target.key)
          revisions.set(id, revisionOf(id) + 1)
          const next = yield* saved()
          yield* install(next)
          return { kind: "saved", servers: next } as const
        })
      )
    )
    if (written.kind === "refused") return written.clash satisfies ChatEndpointSaveResult
    deps.listChanged()
    return {
      result: "saved",
      endpoint: view(stored, written.servers)
    } satisfies ChatEndpointSaveResult
  })

  const remove = Effect.fn("ChatEndpoint.remove")(function* (id: string) {
    const next = yield* deps.lock.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* findSaved(id)
          const next = yield* replaceSaved(id, undefined, undefined)
          keys.delete(id)
          revisions.set(id, revisionOf(id) + 1)
          yield* install(next.chat)
          return next
        })
      )
    )
    deps.listChanged()
    return next
  })

  /**
   * Writes one server and its key together: a failure puts back both. The
   * vault is touched only when a key is or was saved, so a server without
   * one is saved where no vault exists (a configured server, a test). While
   * the key changes, the server is out of the list, so no request pairs its
   * old address with the new key; it goes back in its place.
   */
  const replaceSaved = Effect.fn("ChatEndpoint.replaceSaved")(function* (
    id: string,
    stored: StoredChatEndpoint | undefined,
    key: string | undefined
  ) {
    const previousList = yield* saved()
    const previousStored = previousList.find((server) => server.id === id)
    const write = (next: StoredChatEndpoint | undefined) =>
      deps.update((current) => ({
        chat:
          next === undefined
            ? current.chat.filter((server) => server.id !== id)
            : placed(current.chat, next, previousList)
      }))
    if (key === undefined && previousStored?.auth.kind !== "bearer") return yield* write(stored)
    const previous = yield* deps.secrets.readDocument(id)
    yield* write(undefined)
    const written = key === undefined ? deps.secrets.restore(id, null) : deps.secrets.write(id, key)
    return yield* written.pipe(
      Effect.andThen(write(stored)),
      Effect.catch((cause) =>
        deps.secrets
          .restore(id, previous)
          .pipe(Effect.andThen(write(previousStored)), Effect.andThen(Effect.fail(cause)))
      )
    )
  })

  /**
   * At start: the saved lists go in at once, from what discovery last
   * reported. Then each server is asked again in the background; a working
   * answer refreshes its list (a llama.cpp server restarted with other
   * models), a stopped server is marked unreachable and keeps its models.
   */
  const start = Effect.fn("ChatEndpoint.start")(function* () {
    const servers = yield* saved()
    for (const stored of servers) {
      if (stored.auth.kind !== "bearer") continue
      const key = yield* deps.secrets.read(stored.id)
      if (key === undefined)
        yield* Effect.logWarning("A model server's key is missing; its requests will be refused", {
          id: stored.id
        })
      else keys.set(stored.id, key)
    }
    if (servers.length === 0) return
    yield* install(servers)
    for (const stored of servers)
      yield* Effect.forkScoped(reprobe(stored, keys.get(stored.id), revisionOf(stored.id)))
  })

  const reprobe = (stored: StoredChatEndpoint, key: string | undefined, seen: number) =>
    Effect.gen(function* () {
      // Discovery takes nothing here; another server's ids are left out under the lock below.
      const found = yield* Effect.promise(() =>
        discoverChatEndpoint(targetOf(stored, key, deps), new Map())
      )
      if (found.result === "unreachable" || found.result === "key_refused")
        return yield* report(stored.id, found.result, seen)
      // Anything else (its models now refused, say) keeps the saved list and
      // health: the next Check says what changed, and Save replaces the list.
      if (found.result !== "works")
        return yield* Effect.logWarning("A model server no longer offers its saved models", {
          id: stored.id,
          result: found.result
        })
      const changed = yield* deps.lock.withPermit(
        Effect.gen(function* () {
          const servers = yield* saved()
          const current = servers.find((server) => server.id === stored.id)
          if (revisionOf(stored.id) !== seen || current === undefined) return false
          const kept = untaken(found, takenBy(servers, stored.id))
          if (kept === undefined)
            return yield* Effect.logWarning(
              "A model server now offers only models another server offers",
              { id: stored.id }
            ).pipe(Effect.as(false))
          const changed =
            JSON.stringify([kept.models, kept.skipped]) !==
            JSON.stringify([current.models, current.skipped])
          const health = (yield* deps.nextHealth(current.health, undefined)) ?? current.health
          const next = { ...current, models: kept.models, skipped: kept.skipped, health }
          const all = yield* deps.update((latest) => ({ chat: placed(latest.chat, next) }))
          if (changed) yield* install(all.chat)
          return changed
        })
      )
      if (changed) deps.listChanged()
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not ask a model server again", { id: stored.id, cause })
      )
    )

  return { check, save, remove, start }
})

/** The servers' views, each named beside the others. */
export const viewAll = (
  servers: ReadonlyArray<StoredChatEndpoint>
): ReadonlyArray<ChatModelEndpoint> => servers.map((stored) => view(stored, servers))

const view = (
  stored: StoredChatEndpoint,
  servers: ReadonlyArray<StoredChatEndpoint>
): ChatModelEndpoint => ({
  kind: "chat",
  id: stored.id,
  service: stored.service,
  baseUrl: stored.baseUrl,
  host: new URL(stored.baseUrl).host,
  group: groupOf(chatGroups(servers), stored.id).name,
  auth: stored.auth,
  models: stored.models.map(modelView),
  skipped: stored.skipped,
  health: stored.health
})

/** A draft's identity among the saved servers; a new server's id is not assigned yet. */
const identity = (draft: ChatEndpointDraft, editing: string | undefined): ChatServerIdentity => ({
  id: editing ?? NEW_SERVER,
  service: draft.service,
  baseUrl: draft.baseUrl
})

/** Stands for a server being added in its Check; never an assigned id (`ChatEndpointIdSchema`). */
const NEW_SERVER = "check"

/**
 * The list with `server` in its place: where it is, else where it was in
 * `order` (a server put back after its key changed), else at the end.
 */
const placed = <S extends ChatServerIdentity>(
  servers: ReadonlyArray<S>,
  server: S,
  order: ReadonlyArray<ChatServerIdentity> = servers
): ReadonlyArray<S> => {
  if (servers.some((saved) => saved.id === server.id))
    return servers.map((saved) => (saved.id === server.id ? server : saved))
  const at = order.findIndex((saved) => saved.id === server.id)
  if (at === -1) return [...servers, server]
  const before = new Set(order.slice(0, at).map((saved) => saved.id))
  const index = servers.filter((saved) => before.has(saved.id)).length
  return [...servers.slice(0, index), server, ...servers.slice(index)]
}

const groupOf = (
  groups: ReturnType<typeof chatGroups>,
  id: string
): NonNullable<ReturnType<ReturnType<typeof chatGroups>["get"]>> => {
  const group = groups.get(id)
  if (group === undefined) throw new Error(`No group for model server ${id}`)
  return group
}

/** Every model the other saved servers offer, with the group name that offers it. */
const takenBy = (
  servers: ReadonlyArray<StoredChatEndpoint>,
  editing: string | undefined
): TakenModels => {
  const groups = chatGroups(servers)
  return new Map(
    servers
      .filter((server) => server.id !== editing)
      .flatMap((server) =>
        server.models.map((model) => [model.id, groupOf(groups, server.id).name] as const)
      )
  )
}

/** A draft that names the saved server and its saved key, so its Check is the saved one's health. */
const isSaved = (stored: StoredChatEndpoint, draft: ChatEndpointDraft): boolean =>
  stored.service === draft.service &&
  stored.baseUrl === draft.baseUrl &&
  (draft.service === "llama.cpp" ||
    JSON.stringify(stored.models.map((model) => model.id)) === JSON.stringify(draft.models)) &&
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

/** A saved server as discovery asks it again: llama.cpp lists, the others name their models. */
const targetOf = (
  stored: StoredChatEndpoint,
  key: string | undefined,
  deps: Pick<ChatEndpointDeps, "fetch">
): ChatEndpointTarget => {
  const base = { baseUrl: stored.baseUrl, key, fetch: deps.fetch }
  return stored.service === "llama.cpp"
    ? { ...base, service: "llama.cpp" }
    : { ...base, service: stored.service, models: stored.models.map((model) => model.id) }
}

const modelView = (model: StoredChatEndpoint["models"][number]) => ({
  id: model.id,
  contextWindow: model.window,
  imageInput: model.compat.imageInput === true
})
