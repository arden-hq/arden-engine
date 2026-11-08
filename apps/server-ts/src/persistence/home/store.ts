import { Context, type Effect } from "effect"
import type {
  HomePresenceInput,
  HomeLetterBody,
  HomeLetterResponse,
  HomeEvidenceQuery,
  HomeEvidencePage
} from "@arden-hq/protocol/runs"
import type { WorkStoreError } from "../work/store.js"
import type {
  HomeAddressBook,
  HomeAddressNeeds,
  HomeLetterRules,
  HomeLetterSnapshot
} from "./model.js"
export type { HomeLetterSnapshot } from "./model.js"

export class HomeStore extends Context.Service<
  HomeStore,
  {
    readonly homePresence: (input: HomePresenceInput) => Effect.Effect<void, WorkStoreError>
    readonly homeLetter: () => Effect.Effect<HomeLetterResponse, WorkStoreError>
    readonly homeAddressBook: (
      needs: HomeAddressNeeds
    ) => Effect.Effect<HomeAddressBook, WorkStoreError>
    readonly homeLetterSnapshot: (
      rules: HomeLetterRules
    ) => Effect.Effect<HomeLetterSnapshot, WorkStoreError>
    readonly checkHomeLetter: (
      snapshot: HomeLetterSnapshot,
      rules: HomeLetterRules
    ) => Effect.Effect<"ready" | "no_change" | "skipped_no_input" | "superseded", WorkStoreError>
    readonly publishHomeLetter: (input: {
      readonly runId: string
      readonly snapshot: HomeLetterSnapshot
      readonly body: HomeLetterBody
      readonly rules: HomeLetterRules
    }) => Effect.Effect<boolean, WorkStoreError>
    readonly homeEvidence: (
      options: HomeEvidenceQuery
    ) => Effect.Effect<HomeEvidencePage, WorkStoreError>
  }
>()("@arden-hq/server/persistence/HomeStore") {}
