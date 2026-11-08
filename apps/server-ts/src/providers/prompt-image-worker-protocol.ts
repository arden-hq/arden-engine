import { Schema } from "effect"

export const PromptImageRequest = Schema.Struct({
  data: Schema.String,
  limits: Schema.Struct({
    patchSize: Schema.Number,
    fitSide: Schema.Number,
    fitPatches: Schema.Number,
    maxPatches: Schema.Number
  })
})
export const PromptImageReply = Schema.UndefinedOr(
  Schema.Struct({
    data: Schema.String,
    size: Schema.Struct({ width: Schema.Number, height: Schema.Number })
  })
)
