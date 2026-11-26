import {
  applyIntelligenceSettingsPatch,
  DEFAULT_INTELLIGENCE_SETTINGS,
  type IntelligenceSettingsPatch
} from "@arden-hq/protocol/settings"
import { IntelligenceSettingsSchema } from "@arden-hq/protocol/effect/settings"
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
      patchSchema: IntelligenceSettingsSchema,
      defaults: DEFAULT_INTELLIGENCE_SETTINGS,
      error: IntelligenceSettingsStoreError
    })
    return IntelligenceSettingsStore.of({
      settings: document.read,
      updateSettings: (patch: IntelligenceSettingsPatch) =>
        document.update((current) => applyIntelligenceSettingsPatch(current, patch))
    })
  }
)
