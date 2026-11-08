import { Schema } from "effect"
import { TabRefSchema } from "./service.js"

const PageViewSchema = Schema.Struct({
  url: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  scope: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  depth: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  maxChars: Schema.Number
})

export type BrowserPageView = typeof PageViewSchema.Type

export const BrowserObservationCheckpointSchema = Schema.Struct({
  tabRef: TabRefSchema,
  snapshot: Schema.NullOr(
    Schema.Struct({
      ref: Schema.String.check(Schema.isPattern(/^snap-[a-f0-9]+$/u)),
      revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      targets: Schema.Record(Schema.String, Schema.String),
      url: Schema.optionalKey(Schema.String)
    })
  ),
  view: Schema.NullOr(PageViewSchema)
})

export type BrowserObservationCheckpoint = typeof BrowserObservationCheckpointSchema.Type
