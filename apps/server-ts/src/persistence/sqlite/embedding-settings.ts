import { Effect } from "effect"

import { GRANITE_GGUF_ID } from "../../local-models/catalog.js"
import {
  type EmbeddingSettings,
  EmbeddingSettingsPatchSchema,
  EmbeddingSettingsSchema,
  EmbeddingSettingsStore,
  EmbeddingSettingsStoreError
} from "../settings/store.js"
import type { PersistenceDeps } from "./deps.js"
import { makeSettingsDocument } from "./settings-document.js"

const BUNDLED_GRANITE_ID = "ibm-granite/granite-embedding-97m-multilingual-r2"

const currentEmbeddingSettings = (settings: EmbeddingSettings): EmbeddingSettings =>
  settings.modelId === BUNDLED_GRANITE_ID ? { ...settings, modelId: GRANITE_GGUF_ID } : settings

export const makeEmbeddingSettingsStore = Effect.fn("SqliteEmbeddingSettingsStore.make")(
  function* ({ writer }: Pick<PersistenceDeps, "writer">) {
    const document = yield* makeSettingsDocument({
      writer,
      namespace: "embedding_settings",
      label: "embedding settings",
      schema: EmbeddingSettingsSchema,
      patchSchema: EmbeddingSettingsPatchSchema,
      defaults: { modelId: null, keepIndex: false, paused: false },
      error: EmbeddingSettingsStoreError
    })
    return EmbeddingSettingsStore.of({
      settings: () => document.read().pipe(Effect.map(currentEmbeddingSettings)),
      updateSettings: (patch) => document.update(patch).pipe(Effect.map(currentEmbeddingSettings))
    })
  }
)
