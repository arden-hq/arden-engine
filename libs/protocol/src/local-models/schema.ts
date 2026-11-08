import { Schema } from "effect"
import { NonNegativeIntSchema, withExtras } from "../common/schema.js"
import type { LocalModelInfo, LocalModelInstall, LocalModelsStatus } from "./contracts.js"

const ModelIdSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u))

const bytes = { received_bytes: NonNegativeIntSchema, total_bytes: NonNegativeIntSchema }

const InstallWireSchema = Schema.Union([
  withExtras({ state: Schema.Literal("absent") }),
  withExtras({ state: Schema.Literals(["downloading", "stopped"] as const), ...bytes }),
  withExtras({
    state: Schema.Literal("failed"),
    reason: Schema.Literals(["network", "hash", "disk"] as const),
    ...bytes
  }),
  withExtras({
    state: Schema.Literal("no_space"),
    needed_bytes: NonNegativeIntSchema,
    free_bytes: NonNegativeIntSchema
  }),
  withExtras({ state: Schema.Literal("installed") })
])

const ModelWireSchema = withExtras({
  id: ModelIdSchema,
  kind: Schema.Literals(["embedding", "decision"] as const),
  name: Schema.NonEmptyString,
  license: Schema.NonEmptyString,
  license_url: Schema.NonEmptyString,
  input: Schema.Literals(["text", "text+image"] as const),
  total_bytes: NonNegativeIntSchema,
  dimensions: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  install: InstallWireSchema
})

const RuntimeWireSchema = Schema.Union([
  withExtras({ state: Schema.Literals(["stopped", "starting", "running"] as const) }),
  withExtras({ state: Schema.Literal("failed"), error: Schema.NonEmptyString })
])

export const LocalModelsStatusResponseSchema = withExtras({
  models: Schema.Array(ModelWireSchema),
  free_bytes: Schema.NullOr(NonNegativeIntSchema),
  runtime: RuntimeWireSchema
})

type InstallWire = Schema.Schema.Type<typeof InstallWireSchema>
type ModelWire = Schema.Schema.Type<typeof ModelWireSchema>
type StatusWire = Schema.Schema.Type<typeof LocalModelsStatusResponseSchema>

const installFromWire = (install: InstallWire): LocalModelInstall => {
  switch (install.state) {
    case "absent":
    case "installed":
      return { state: install.state }
    case "downloading":
    case "stopped":
      return {
        state: install.state,
        receivedBytes: install.received_bytes,
        totalBytes: install.total_bytes
      }
    case "failed":
      return {
        state: "failed",
        reason: install.reason,
        receivedBytes: install.received_bytes,
        totalBytes: install.total_bytes
      }
    case "no_space":
      return { state: "no_space", neededBytes: install.needed_bytes, freeBytes: install.free_bytes }
  }
}

const installToWire = (install: LocalModelInstall): InstallWire => {
  switch (install.state) {
    case "absent":
    case "installed":
      return { state: install.state }
    case "downloading":
    case "stopped":
      return {
        state: install.state,
        received_bytes: install.receivedBytes,
        total_bytes: install.totalBytes
      }
    case "failed":
      return {
        state: "failed",
        reason: install.reason,
        received_bytes: install.receivedBytes,
        total_bytes: install.totalBytes
      }
    case "no_space":
      return { state: "no_space", needed_bytes: install.neededBytes, free_bytes: install.freeBytes }
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
  dimensions: model.dimensions,
  install: installFromWire(model.install)
})

export const mapLocalModelsStatus = (status: StatusWire): LocalModelsStatus => ({
  models: status.models.map(modelFromWire),
  freeBytes: status.free_bytes,
  runtime:
    status.runtime.state === "failed"
      ? { state: "failed", error: status.runtime.error }
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
    dimensions: model.dimensions,
    install: installToWire(model.install)
  })),
  free_bytes: status.freeBytes,
  runtime:
    status.runtime.state === "failed"
      ? { state: "failed", error: status.runtime.error }
      : { state: status.runtime.state }
})
