import { withExtras } from "../common/schema.js"
import {
  mapSettings,
  ModelSettingsPatchRequestSchema,
  modelSettingsConsistency,
  modelSettingsResponseFields
} from "../models/schema.js"
import type { ConfigSettings } from "./contracts.js"

export const ConfigPatchRequestSchema = ModelSettingsPatchRequestSchema

export const ConfigResponseSchema = withExtras(modelSettingsResponseFields).check(
  modelSettingsConsistency
)

export const toConfigSettings = (config: typeof ConfigResponseSchema.Type): ConfigSettings => ({
  models: mapSettings(config)
})
