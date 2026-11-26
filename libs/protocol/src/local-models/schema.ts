import { Schema } from "effect"
import { NonNegativeIntSchema, withExtras } from "../common/schema.js"
import { MODEL_ENDPOINT_INPUT } from "../model-endpoints/contracts.js"
import {
  LOCAL_MODEL_INSTALL_REASON,
  LOCAL_MODEL_INSTALL_STATE,
  LOCAL_MODEL_KIND,
  LOCAL_MODEL_RUNTIME,
  LOCAL_MODELS_FREE_SPACE,
  type LocalModelInfo,
  type LocalModelInstall,
  type LocalModelsStatus
} from "./contracts.js"

const ModelIdSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u))

const bytes = { received_bytes: NonNegativeIntSchema, total_bytes: NonNegativeIntSchema }

const InstallWireSchema = Schema.Union([
  withExtras({ state: Schema.Literal(LOCAL_MODEL_INSTALL_STATE.absent) }),
  withExtras({
    state: Schema.Literals([
      LOCAL_MODEL_INSTALL_STATE.downloading,
      LOCAL_MODEL_INSTALL_STATE.stopped
    ]),
    ...bytes
  }),
  withExtras({
    state: Schema.Literal(LOCAL_MODEL_INSTALL_STATE.failed),
    reason: Schema.Literals(Object.values(LOCAL_MODEL_INSTALL_REASON)),
    ...bytes
  }),
  withExtras({
    state: Schema.Literal(LOCAL_MODEL_INSTALL_STATE.noSpace),
    needed_bytes: NonNegativeIntSchema,
    free_bytes: NonNegativeIntSchema
  }),
  withExtras({ state: Schema.Literal(LOCAL_MODEL_INSTALL_STATE.installed) })
])

const ModelWireSchema = withExtras({
  id: ModelIdSchema,
  kind: Schema.Literals(Object.values(LOCAL_MODEL_KIND)),
  name: Schema.NonEmptyString,
  license: Schema.NonEmptyString,
  license_url: Schema.NonEmptyString,
  input: Schema.Literals(Object.values(MODEL_ENDPOINT_INPUT)),
  total_bytes: NonNegativeIntSchema,
  install: InstallWireSchema
})

const RuntimeWireSchema = Schema.Union([
  withExtras({
    state: Schema.Literals([
      LOCAL_MODEL_RUNTIME.stopped,
      LOCAL_MODEL_RUNTIME.starting,
      LOCAL_MODEL_RUNTIME.running
    ])
  }),
  withExtras({ state: Schema.Literal(LOCAL_MODEL_RUNTIME.failed), error: Schema.NonEmptyString })
])

export const LocalModelsStatusResponseSchema = withExtras({
  models: Schema.Array(ModelWireSchema),
  free_space: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal(LOCAL_MODELS_FREE_SPACE.measured),
      bytes: NonNegativeIntSchema
    }),
    Schema.Struct({ kind: Schema.Literal(LOCAL_MODELS_FREE_SPACE.unmeasured) })
  ]),
  runtime: RuntimeWireSchema
})

type InstallWire = Schema.Schema.Type<typeof InstallWireSchema>
type ModelWire = Schema.Schema.Type<typeof ModelWireSchema>
type StatusWire = Schema.Schema.Type<typeof LocalModelsStatusResponseSchema>

const installFromWire = (install: InstallWire): LocalModelInstall => {
  switch (install.state) {
    case LOCAL_MODEL_INSTALL_STATE.absent:
    case LOCAL_MODEL_INSTALL_STATE.installed:
      return { state: install.state }
    case LOCAL_MODEL_INSTALL_STATE.downloading:
    case LOCAL_MODEL_INSTALL_STATE.stopped:
      return {
        state: install.state,
        receivedBytes: install.received_bytes,
        totalBytes: install.total_bytes
      }
    case LOCAL_MODEL_INSTALL_STATE.failed:
      return {
        state: LOCAL_MODEL_INSTALL_STATE.failed,
        reason: install.reason,
        receivedBytes: install.received_bytes,
        totalBytes: install.total_bytes
      }
    case LOCAL_MODEL_INSTALL_STATE.noSpace:
      return {
        state: LOCAL_MODEL_INSTALL_STATE.noSpace,
        neededBytes: install.needed_bytes,
        freeBytes: install.free_bytes
      }
  }
}

const installToWire = (install: LocalModelInstall): InstallWire => {
  switch (install.state) {
    case LOCAL_MODEL_INSTALL_STATE.absent:
    case LOCAL_MODEL_INSTALL_STATE.installed:
      return { state: install.state }
    case LOCAL_MODEL_INSTALL_STATE.downloading:
    case LOCAL_MODEL_INSTALL_STATE.stopped:
      return {
        state: install.state,
        received_bytes: install.receivedBytes,
        total_bytes: install.totalBytes
      }
    case LOCAL_MODEL_INSTALL_STATE.failed:
      return {
        state: LOCAL_MODEL_INSTALL_STATE.failed,
        reason: install.reason,
        received_bytes: install.receivedBytes,
        total_bytes: install.totalBytes
      }
    case LOCAL_MODEL_INSTALL_STATE.noSpace:
      return {
        state: LOCAL_MODEL_INSTALL_STATE.noSpace,
        needed_bytes: install.neededBytes,
        free_bytes: install.freeBytes
      }
  }
}

const modelFromWire = (model: ModelWire): LocalModelInfo => ({
  id: model.id,
  kind: model.kind,
  name: model.name,
  license: model.license,
  licenseUrl: model.license_url,
  input: model.input,
  totalBytes: model.total_bytes,
  install: installFromWire(model.install)
})

export const mapLocalModelsStatus = (status: StatusWire): LocalModelsStatus => ({
  models: status.models.map(modelFromWire),
  freeSpace: status.free_space,
  runtime:
    status.runtime.state === LOCAL_MODEL_RUNTIME.failed
      ? { state: LOCAL_MODEL_RUNTIME.failed, error: status.runtime.error }
      : { state: status.runtime.state }
})

export const localModelsStatusResponse = (status: LocalModelsStatus): StatusWire => ({
  models: status.models.map((model) => ({
    id: model.id,
    kind: model.kind,
    name: model.name,
    license: model.license,
    license_url: model.licenseUrl,
    input: model.input,
    total_bytes: model.totalBytes,
    install: installToWire(model.install)
  })),
  free_space: status.freeSpace,
  runtime:
    status.runtime.state === LOCAL_MODEL_RUNTIME.failed
      ? { state: LOCAL_MODEL_RUNTIME.failed, error: status.runtime.error }
      : { state: status.runtime.state }
})
