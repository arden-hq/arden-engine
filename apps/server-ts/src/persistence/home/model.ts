import { Schema } from "effect"
import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import { HomeEvidenceSchema, HomeLetterResponseSchema } from "@arden-hq/protocol/effect/runs"
import type { HomeEvidence } from "@arden-hq/protocol/runs"

const HomeLetterSnapshotSchema = Schema.Struct({
  window: HomeLetterResponseSchema.fields.window,
  fingerprint: Schema.NonEmptyString,
  instruction: Schema.NonEmptyString,
  task_state: Schema.Array(
    Schema.Struct({ item_id: Schema.NonEmptyString, version: Schema.NonEmptyString })
  ).check(Schema.isMaxLength(200)),
  through: IsoDateTimeStringSchema,
  headline: HomeLetterResponseSchema.fields.headline,
  entries: Schema.Array(HomeEvidenceSchema).check(Schema.isMaxLength(200))
})
export type HomeLetterSnapshot = typeof HomeLetterSnapshotSchema.Type

export const HomeLetterInputSchema = Schema.Struct({
  snapshot: HomeLetterSnapshotSchema,
  prompt: Schema.NonEmptyString
})
export type HomeLetterInput = typeof HomeLetterInputSchema.Type

export interface HomeLetterRules {
  readonly instruction: string
  readonly select: (entries: ReadonlyArray<HomeEvidence>) => ReadonlyArray<HomeEvidence>
  readonly normalize: (entry: HomeEvidence) => HomeEvidence
  readonly fingerprint: (snapshot: Omit<HomeLetterSnapshot, "fingerprint">) => string
  readonly linkIds: (entries: ReadonlyArray<HomeEvidence>) => ReadonlyArray<string>
}

export interface HomeAddressNeeds {
  readonly sessionIds: ReadonlyArray<string>
  readonly runIds: ReadonlyArray<string>
}

export interface HomeAddressBook {
  readonly sessionRefs: ReadonlyMap<string, string>
  readonly runTurns: ReadonlyMap<string, string>
}
