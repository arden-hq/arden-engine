import { withExtras } from "../common/schema.js"
import {
  mapSettings,
  ModelSettingsPatchRequestSchema,
  modelSettingsConsistency,
  modelSettingsResponseFields
} from "../models/schema.js"
import type { ConfigSettings } from "./contracts.js"

/** `PATCH /config` body: the model settings, exact (excess keys refused). */
export const ConfigPatchRequestSchema = ModelSettingsPatchRequestSchema

/** `GET /config` (and the settings every `/config` write answers with). */
export const ConfigResponseSchema = withExtras(modelSettingsResponseFields).check(
  modelSettingsConsistency
)

export const toConfigSettings = (config: typeof ConfigResponseSchema.Type): ConfigSettings => ({
  models: mapSettings(config)
})
