import { decoderFor, makeEncoder, projectedDecoderFor } from "../common/boundary.js"
import type { ModelResetScope, ModelSettingsPatch } from "./contracts.js"
import {
  ModelCatalogResponseSchema,
  mapCatalog,
  ModelSettingsResponseSchema,
  mapSettings,
  encodeModelResetEffect,
  encodeModelSettingsPatchEffect,
  TranscribeResponseSchema
} from "./schema.js"

export * from "./contracts.js"

export const modelDecoders = {
  catalog: projectedDecoderFor(ModelCatalogResponseSchema, mapCatalog, "Invalid model catalog"),
  settings: projectedDecoderFor(ModelSettingsResponseSchema, mapSettings, "Invalid model settings"),
  transcription: decoderFor(TranscribeResponseSchema, "Invalid transcription")
} as const

export const modelRequests = {
  reset: makeEncoder<{ readonly scope: ModelResetScope }>(
    encodeModelResetEffect,
    "Invalid model reset"
  ),
  update: makeEncoder<ModelSettingsPatch>(
    encodeModelSettingsPatchEffect,
    "Invalid model settings patch"
  )
} as const

export const modelRoutes = {
  catalog: "/models",
  settings: "/config",
  resetSettings: "/config/models/reset",
  transcribe: "/transcribe"
} as const
