import { type HomeLetterBody, type HomeLetterResponse } from "./letter-schema.js"
import type { JobLeaseRef } from "@arden-hq/jobs"
import { Context, type Effect } from "effect"
import type { HomePresenceInput } from "@arden-hq/protocol/runs"
import type { WorkStoreError } from "../work/store.js"
import type {
  HomeAddressBook,
  HomeAddressNeeds,
  HomeLetterRules,
  HomeLetterSnapshot
} from "./model.js"
export type { HomeLetterSnapshot } from "./model.js"

export const HOME_LETTER_DISPOSITION = {
  ready: "ready",
  noChange: "no_change",
  skippedNoInput: "skipped_no_input",
  superseded: "superseded"
} as const
export type HomeLetterDisposition =
  (typeof HOME_LETTER_DISPOSITION)[keyof typeof HOME_LETTER_DISPOSITION]

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
    ) => Effect.Effect<HomeLetterDisposition, WorkStoreError>
    readonly publishHomeLetter: (input: {
      readonly lease: JobLeaseRef
      readonly attemptId: number
      readonly runId: string
      readonly snapshot: HomeLetterSnapshot
      readonly body: HomeLetterBody
      readonly rules: HomeLetterRules
    }) => Effect.Effect<boolean, WorkStoreError>
  }
>()("@arden-hq/server/persistence/HomeStore") {}
