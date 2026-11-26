import { Schema } from "effect"
import type {
  ComputerApp,
  ComputerStatus,
  ComputerOperation,
  ComputerPreview,
  ComputerFeedback,
  ComputerSession,
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
  Schema.Struct({ kind: Schema.Literal("unlocated") }),
  Schema.Struct({
    kind: Schema.Literal("pointer"),
    id: Schema.String,
    frame: FeedbackFrame,
    x: Schema.Number,
    y: Schema.Number
  }),
  Schema.Struct({
    kind: Schema.Literal("target"),
    id: Schema.String,
    frame: FeedbackFrame,
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number
  })
])

const ComputerAppSchema: Schema.Codec<ComputerApp> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unidentified") }),
  Schema.Struct({ kind: Schema.Literal("identified"), name: Schema.String, icon: Schema.String })
])

const ComputerOperationSchema: Schema.Codec<ComputerOperation> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unlabelled") }),
  Schema.Struct({
    kind: Schema.Literal("labelled"),
    label: Schema.String,
    delivery: Schema.Literals(["none", "background", "foreground"]),
    feedback: FeedbackSchema
  })
])

const ComputerSessionSchema: Schema.Codec<ComputerSession> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unclaimed") }),
  Schema.Struct({
    kind: Schema.Literal("claimed"),
    session_id: Schema.String,
    target: Schema.String,
    application: ComputerAppSchema,
    operation: ComputerOperationSchema,
    preview: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("empty") }),
      Schema.Struct({
        kind: Schema.Literal("captured"),
        id: Schema.String,
        captured_at: Schema.Number,
        surface: Schema.String
      })
    ])
  })
])

export const ComputerStatusSchema: Schema.Codec<ComputerStatus> = Schema.Struct({
  mode: Schema.Literals(["ready", "paused"]),
  foreground_allowed: Schema.Boolean,
  session: ComputerSessionSchema,
  activity: Schema.Literals(["idle", "observing", "acting"])
})

export const ComputerPreviewSchema: Schema.Codec<ComputerPreview> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("empty") }),
  Schema.Struct({
    kind: Schema.Literal("captured"),
    id: Schema.String,
    session_id: Schema.String,
    captured_at: Schema.Number,
    data_url: Schema.String,
    width: Schema.Number,
    height: Schema.Number
  })
])

export const ComputerStepSchema: Schema.Codec<ComputerStep> = Schema.Struct({
  kind: Schema.Literals(["look", "act"]),
  title: Schema.String,
  app: ComputerAppSchema,
  window: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("untitled") }),
    Schema.Struct({ kind: Schema.Literal("titled"), title: Schema.String })
  ]),
  frames: Schema.Array(
    Schema.Struct({
      image: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
      caption: Schema.String
    })
  )
})
