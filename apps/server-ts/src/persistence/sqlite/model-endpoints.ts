import { Effect } from "effect"

import {
  DEFAULT_MODEL_ENDPOINT_SETTINGS,
  ModelEndpointSettingsPatchSchema,
  ModelEndpointSettingsSchema,
  ModelEndpointStore,
  ModelEndpointStoreError
} from "../model-endpoints/store.js"
import type { PersistenceDeps } from "./deps.js"
import { makeSettingsDocument } from "./settings-document.js"

export const makeModelEndpointStore = Effect.fn("SqliteModelEndpointStore.make")(function* ({
  writer
}: Pick<PersistenceDeps, "writer">) {
  const document = yield* makeSettingsDocument({
    writer,
    namespace: "model_endpoint_settings",
    label: "model endpoint settings",
    schema: ModelEndpointSettingsSchema,
    patchSchema: ModelEndpointSettingsPatchSchema,
    defaults: DEFAULT_MODEL_ENDPOINT_SETTINGS,
    error: ModelEndpointStoreError
  })
  return ModelEndpointStore.of({
    settings: document.read,
    updateSettings: document.update
  })
})
