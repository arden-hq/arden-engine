import type {
  ModelAssignment,
  ModelCatalog,
  ModelResetScope,
  ModelRole,
  ModelSettingsPatch
} from "@arden-hq/protocol/models"
import { Result, Schema } from "effect"
import type { ModelDefinition, ModelHost } from "../../models/host.js"
import type { ModelSettingsSnapshot } from "./store.js"

const modelRoles = ["background", "helper"] as const
const Text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Effort = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const Assignment = Schema.Struct({
  modelId: Schema.NullOr(Text),
  reasoningEffort: Schema.NullOr(Effort)
})
export const SettingsJson = Schema.fromJsonString(
  Schema.Struct({
    chatModelId: Schema.NullOr(Text),
    modelReasoningEfforts: Schema.Record(Text, Effort),
    roleOverrides: Schema.Struct({
      background: Assignment,
      helper: Assignment
    })
  })
)
export type PersistedModelSettings = (typeof SettingsJson)["Type"]
export interface SettingsFault {
  readonly reason: "invalid" | "conflict" | "unavailable"
  readonly message: string
}
export interface ModelSettingsRuntime {
  readonly available: boolean
  readonly catalog: ModelCatalog
  readonly defaults: PersistedModelSettings
  readonly models: ReadonlyMap<string, ModelDefinition>
}

const assignment = (
  modelId: string | null = null,
  reasoningEffort: string | null = null
): ModelAssignment => ({ modelId, reasoningEffort })
const roles = (make: (role: ModelRole) => ModelAssignment = () => assignment()) => ({
  background: make("background"),
  helper: make("helper")
})
const emptySettings = (): PersistedModelSettings => ({
  chatModelId: null,
  modelReasoningEfforts: {},
  roleOverrides: roles()
})
export const emptySnapshot = (): ModelSettingsSnapshot => ({
  effective: { chat: assignment(), roles: roles() },
  atDefaults: { chat: true, roles: true },
  ...emptySettings()
})

const sameAssignment = (left: ModelAssignment, right: ModelAssignment): boolean =>
  left.modelId === right.modelId && left.reasoningEffort === right.reasoningEffort

const sameChat = (left: PersistedModelSettings, right: PersistedModelSettings): boolean => {
  if (left.chatModelId !== right.chatModelId) return false
  const leftEfforts = Object.entries(left.modelReasoningEfforts)
  if (leftEfforts.length !== Object.keys(right.modelReasoningEfforts).length) return false
  return leftEfforts.every(([id, effort]) => right.modelReasoningEfforts[id] === effort)
}

const sameRoles = (left: PersistedModelSettings, right: PersistedModelSettings): boolean =>
  modelRoles.every((role) => sameAssignment(left.roleOverrides[role], right.roleOverrides[role]))

export const resetScope = (
  stored: PersistedModelSettings,
  defaults: PersistedModelSettings,
  scope: ModelResetScope
): PersistedModelSettings =>
  scope === "chat"
    ? {
        ...stored,
        chatModelId: defaults.chatModelId,
        modelReasoningEfforts: { ...defaults.modelReasoningEfforts }
      }
    : { ...stored, roleOverrides: roles((role) => ({ ...defaults.roleOverrides[role] })) }

export const makeSettingsRuntime = (host?: ModelHost): ModelSettingsRuntime => {
  const models = new Map((host?.models ?? []).map((model) => [model.id, model]))
  const groups = new Map<string, { name: string; models: Array<ModelDefinition> }>()
  for (const model of models.values()) {
    const group = groups.get(model.provider.id)
    group === undefined
      ? groups.set(model.provider.id, { name: model.provider.name, models: [model] })
      : group.models.push(model)
  }
  return {
    available: models.size > 0,
    models,
    catalog: {
      providers: [...groups].map(([id, group]) => ({
        id,
        name: group.name,
        models: group.models.map(({ id, name, reasoningEfforts }) => ({
          id,
          name,
          reasoningEfforts: [...reasoningEfforts]
        }))
      }))
    },
    defaults:
      host === undefined
        ? emptySettings()
        : {
            chatModelId: host.defaults.chatModelId,
            modelReasoningEfforts: { ...host.defaults.reasoningEfforts },
            roleOverrides: roles((role) => ({ ...host.defaults.roles[role] }))
          }
  }
}

const fail = <A>(
  reason: SettingsFault["reason"],
  message: string
): Result.Result<A, SettingsFault> => Result.fail({ reason, message })
const model = (
  runtime: ModelSettingsRuntime,
  id: string,
  reason: "invalid" | "conflict" = "conflict"
): Result.Result<ModelDefinition, SettingsFault> => {
  const found = runtime.models.get(id)
  return found === undefined ? fail(reason, `Model ${id} is not available`) : Result.succeed(found)
}
export const validTarget = (
  runtime: ModelSettingsRuntime,
  modelId: string | null,
  effort?: string | null
): Result.Result<void, SettingsFault> =>
  Result.gen(function* () {
    if (modelId === null) {
      if (effort !== undefined && effort !== null)
        return yield* fail<void>("invalid", "A reasoning effort requires a model")
      return
    }
    if (!runtime.available)
      return yield* fail<void>("unavailable", "No model catalog is configured")
    const selected = yield* model(runtime, modelId, "invalid")
    if (effort !== undefined && effort !== null && !selected.reasoningEfforts.includes(effort)) {
      return yield* fail<void>(
        "invalid",
        `Reasoning effort ${effort} is not supported by ${modelId}`
      )
    }
  })

export const snapshot = (
  stored: PersistedModelSettings,
  defaults: PersistedModelSettings
): ModelSettingsSnapshot => {
  const chat = assignment(
    stored.chatModelId,
    stored.chatModelId === null ? null : (stored.modelReasoningEfforts[stored.chatModelId] ?? null)
  )
  const effectiveRoles = roles((role) => {
    const override = stored.roleOverrides[role]
    const modelId = override.modelId ?? chat.modelId
    return assignment(
      modelId,
      override.reasoningEffort ??
        (modelId === null ? null : (stored.modelReasoningEfforts[modelId] ?? null))
    )
  })
  return {
    effective: { chat, roles: effectiveRoles },
    atDefaults: { chat: sameChat(stored, defaults), roles: sameRoles(stored, defaults) },
    chatModelId: stored.chatModelId,
    modelReasoningEfforts: { ...stored.modelReasoningEfforts },
    roleOverrides: roles((role) => ({ ...stored.roleOverrides[role] }))
  }
}

export const applyPatch = (
  stored: PersistedModelSettings,
  patch: ModelSettingsPatch,
  runtime: ModelSettingsRuntime
): Result.Result<PersistedModelSettings, SettingsFault> =>
  Result.gen(function* () {
    if (!runtime.available)
      return yield* fail<PersistedModelSettings>("unavailable", "No model catalog is configured")
    let chatModelId = stored.chatModelId
    const efforts = { ...stored.modelReasoningEfforts }
    const overrides = roles((role) => ({ ...stored.roleOverrides[role] }))
    if (patch.chatModelId !== undefined) {
      yield* validTarget(runtime, patch.chatModelId)
      chatModelId = patch.chatModelId
    }
    if (patch.modelReasoning !== undefined) {
      const { modelId, effort } = patch.modelReasoning
      yield* validTarget(runtime, modelId, effort)
      effort === null ? delete efforts[modelId] : (efforts[modelId] = effort)
    }
    for (const role of modelRoles) {
      const change = patch.roles?.[role]
      if (change === undefined) continue
      const previous = overrides[role]
      const modelId = change.modelId === undefined ? previous.modelId : change.modelId
      const modelChanged = change.modelId !== undefined && change.modelId !== previous.modelId
      const carriedEffort = modelChanged ? null : previous.reasoningEffort
      const reasoningEffort =
        change.reasoningEffort !== undefined ? change.reasoningEffort : carriedEffort
      if (modelId !== null || reasoningEffort !== null)
        yield* validTarget(runtime, modelId ?? chatModelId, reasoningEffort)
      overrides[role] = assignment(modelId, reasoningEffort)
    }
    return { chatModelId, modelReasoningEfforts: efforts, roleOverrides: overrides }
  })

const resolveAssignment = (
  selected: ModelAssignment,
  runtime: ModelSettingsRuntime
): Result.Result<ModelAssignment, SettingsFault> =>
  Result.gen(function* () {
    if (selected.modelId === null) return selected
    const definition = yield* model(runtime, selected.modelId)
    return assignment(
      selected.modelId,
      selected.reasoningEffort !== null &&
        definition.reasoningEfforts.includes(selected.reasoningEffort)
        ? selected.reasoningEffort
        : null
    )
  })

export const selectModel = (
  stored: PersistedModelSettings,
  override: string | null,
  runtime: ModelSettingsRuntime
): Result.Result<ModelAssignment, SettingsFault> => {
  const modelId = override ?? stored.chatModelId
  return resolveAssignment(
    assignment(modelId, modelId === null ? null : (stored.modelReasoningEfforts[modelId] ?? null)),
    runtime
  )
}

export const selectRole = (
  stored: PersistedModelSettings,
  role: ModelRole,
  runtime: ModelSettingsRuntime
): Result.Result<ModelAssignment, SettingsFault> =>
  resolveAssignment(snapshot(stored, runtime.defaults).effective.roles[role], runtime)

export const migrateLegacyRoles = (json: string): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return json
  }
  if (typeof parsed !== "object" || parsed === null) return json
  const overrides = (parsed as { roleOverrides?: unknown }).roleOverrides
  if (typeof overrides !== "object" || overrides === null || !("workflow" in overrides)) return json
  const legacy = overrides as Record<
    "workflow" | "auxiliary" | "memory",
    ModelAssignment | undefined
  >
  const workflow = legacy.workflow ?? assignment()
  return JSON.stringify({
    ...parsed,
    roleOverrides: {
      background: workflow.modelId === null ? (legacy.memory ?? assignment()) : workflow,
      helper: legacy.auxiliary ?? assignment()
    }
  })
}
