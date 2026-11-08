import type { ModelSettingsResponse } from "../models/contracts.js"

/** `GET /config`: one response composed of each settings owner's projection. */
export interface ConfigSettings {
  readonly models: ModelSettingsResponse
}
