import { Schema } from "effect"

export class FetchError extends Schema.TaggedError<FetchError>()("ConnectionFetchError", {
  source: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}
