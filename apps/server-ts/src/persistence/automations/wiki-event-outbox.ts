import { Context, type Effect } from "effect"
import type { AutomationTriggerEvent } from "./model.js"
import type { AutomationStoreError } from "./store.js"
import type { AutomationEventDispatchOutcome } from "./triggers.js"

export class WikiEventOutbox extends Context.Service<
  WikiEventOutbox,
  {
    readonly wikiPublicationCursor: (
      initialRevision: string | null
    ) => Effect.Effect<string | null, AutomationStoreError>
    readonly publishWikiChange: (input: {
      readonly previousRevision: string | null
      readonly revision: string
      readonly event: AutomationTriggerEvent | undefined
    }) => Effect.Effect<AutomationEventDispatchOutcome | null, AutomationStoreError>
  }
>()("@arden-hq/server/persistence/automations/WikiEventOutbox") {}
