import { Schema } from "effect"
import type {
  ComputerStatus,
  ComputerPreview,
  ComputerFeedback,
  ComputerStep
} from "./contracts.js"
import type { ComputerSetup } from "./contracts.js"

export const ComputerSetupSchema: Schema.Codec<ComputerSetup> = Schema.Struct({
  version: Schema.String,
  permissions: Schema.Union([
    Schema.Struct({ kind: Schema.Literals(["idle", "running", "granted"]) }),
    Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String })
  ]),
  installation: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("unsupported") }),
    Schema.Struct({ kind: Schema.Literal("disabled") }),
    Schema.Struct({
      kind: Schema.Literal("downloading"),
      receivedBytes: Schema.Number,
      totalBytes: Schema.Number
    }),
    Schema.Struct({ kind: Schema.Literal("verifying") }),
    Schema.Struct({ kind: Schema.Literal("waiting") }),
    Schema.Struct({ kind: Schema.Literal("installed") }),
    Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String })
  ])
})

const FeedbackFrame = Schema.Struct({ width: Schema.Number, height: Schema.Number })
const FeedbackSchema: Schema.Codec<ComputerFeedback> = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    frame: FeedbackFrame,
    kind: Schema.Literal("pointer"),
    x: Schema.Number,
    y: Schema.Number
  }),
  Schema.Struct({
    id: Schema.String,
    frame: FeedbackFrame,
    kind: Schema.Literal("target"),
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number
  })
])

export const ComputerStatusSchema: Schema.Codec<ComputerStatus> = Schema.Struct({
  mode: Schema.Literals(["ready", "paused"]),
  session_id: Schema.NullOr(Schema.String),
  foreground_allowed: Schema.Boolean,
  target: Schema.NullOr(Schema.String),
  application: Schema.NullOr(Schema.Struct({ name: Schema.String, icon: Schema.String })),
  operation: Schema.NullOr(
    Schema.Struct({
      label: Schema.String,
      delivery: Schema.NullOr(Schema.Literals(["background", "foreground"])),
      feedback: Schema.NullOr(FeedbackSchema)
    })
  ),
  preview: Schema.NullOr(
    Schema.Struct({ id: Schema.String, captured_at: Schema.Number, surface: Schema.String })
  ),
  activity: Schema.Literals(["idle", "observing", "acting"])
})

export const ComputerPreviewSchema: Schema.Codec<ComputerPreview | null> = Schema.NullOr(
  Schema.Struct({
    id: Schema.String,
    session_id: Schema.String,
    captured_at: Schema.Number,
    data_url: Schema.String,
    width: Schema.Number,
    height: Schema.Number
  })
)

export const ComputerStepSchema: Schema.Codec<ComputerStep> = Schema.Struct({
  kind: Schema.Literals(["look", "act"]),
  title: Schema.String,
  app: Schema.NullOr(Schema.Struct({ name: Schema.String, icon: Schema.String })),
  window: Schema.NullOr(Schema.String),
  frames: Schema.Array(
    Schema.Struct({
      image: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
      caption: Schema.String
    })
  )
})
