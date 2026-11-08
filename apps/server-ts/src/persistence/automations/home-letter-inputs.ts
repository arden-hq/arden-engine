import { Context, type Effect } from "effect"
import type { HomeLetterInput } from "../home/model.js"
import type { AutomationJobLeaseRef, AutomationStoreError } from "./store.js"

export class HomeLetterInputs extends Context.Service<
  HomeLetterInputs,
  {
    readonly freezeHomeInput: (
      lease: AutomationJobLeaseRef,
      input: HomeLetterInput
    ) => Effect.Effect<HomeLetterInput, AutomationStoreError>
  }
>()("@arden-hq/server/persistence/automations/HomeLetterInputs") {}
