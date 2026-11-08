import { DEFAULT_INTELLIGENCE_SETTINGS } from "@arden-hq/protocol/settings"
import {
  IntelligenceSettingsPatchSchema,
  IntelligenceSettingsSchema
} from "@arden-hq/protocol/effect/settings"
import { Effect } from "effect"

import { IntelligenceSettingsStore, IntelligenceSettingsStoreError } from "../settings/store.js"
import type { PersistenceDeps } from "./deps.js"
import { makeSettingsDocument } from "./settings-document.js"

export const makeIntelligenceSettingsStore = Effect.fn("SqliteIntelligenceSettingsStore.make")(
  function* ({ writer }: Pick<PersistenceDeps, "writer">) {
    const document = yield* makeSettingsDocument({
      writer,
      namespace: "intelligence_settings",
      label: "intelligence settings",
      schema: IntelligenceSettingsSchema,
      patchSchema: IntelligenceSettingsPatchSchema,
      defaults: DEFAULT_INTELLIGENCE_SETTINGS,
      error: IntelligenceSettingsStoreError
    })
    return IntelligenceSettingsStore.of({
      settings: document.read,
      updateSettings: document.update
    })
  }
)
