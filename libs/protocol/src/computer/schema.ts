import { Schema } from "effect"
import {
  COMPUTER_ACTIVITY,
  COMPUTER_APP,
  COMPUTER_DELIVERY,
  COMPUTER_FEEDBACK,
  COMPUTER_INSTALLATION,
  COMPUTER_MODE,
  COMPUTER_OPERATION,
  COMPUTER_PERMISSIONS,
  COMPUTER_PREVIEW,
  COMPUTER_SESSION,
  COMPUTER_STEP,
  COMPUTER_WINDOW,
  type ComputerApp,
  type ComputerStatus,
  type ComputerOperation,
  type ComputerPreview,
  type ComputerFeedback,
  type ComputerSession,
  type ComputerStep,
  type ComputerSetup
} from "./contracts.js"

export const ComputerSetupSchema: Schema.Codec<ComputerSetup> = Schema.Struct({
  version: Schema.String,
  permissions: Schema.Union([
    Schema.Struct({
      kind: Schema.Literals([
        COMPUTER_PERMISSIONS.idle,
        COMPUTER_PERMISSIONS.running,
        COMPUTER_PERMISSIONS.granted
      ])
    }),
    Schema.Struct({ kind: Schema.Literal(COMPUTER_PERMISSIONS.failed), message: Schema.String })
  ]),
  installation: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(COMPUTER_INSTALLATION.unsupported) }),
    Schema.Struct({ kind: Schema.Literal(COMPUTER_INSTALLATION.disabled) }),
    Schema.Struct({
      kind: Schema.Literal(COMPUTER_INSTALLATION.downloading),
      receivedBytes: Schema.Number,
      totalBytes: Schema.Number
    }),
    Schema.Struct({ kind: Schema.Literal(COMPUTER_INSTALLATION.verifying) }),
    Schema.Struct({ kind: Schema.Literal(COMPUTER_INSTALLATION.waiting) }),
    Schema.Struct({ kind: Schema.Literal(COMPUTER_INSTALLATION.installed) }),
    Schema.Struct({ kind: Schema.Literal(COMPUTER_INSTALLATION.failed), message: Schema.String })
  ])
})

const FeedbackFrame = Schema.Struct({ width: Schema.Number, height: Schema.Number })
const FeedbackSchema: Schema.Codec<ComputerFeedback> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(COMPUTER_FEEDBACK.unlocated) }),
  Schema.Struct({
    kind: Schema.Literal(COMPUTER_FEEDBACK.pointer),
    id: Schema.String,
    frame: FeedbackFrame,
    x: Schema.Number,
    y: Schema.Number
  }),
  Schema.Struct({
    kind: Schema.Literal(COMPUTER_FEEDBACK.target),
    id: Schema.String,
    frame: FeedbackFrame,
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number
  })
])

const ComputerAppSchema: Schema.Codec<ComputerApp> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(COMPUTER_APP.unidentified) }),
  Schema.Struct({
    kind: Schema.Literal(COMPUTER_APP.identified),
    name: Schema.String,
    icon: Schema.String
  })
])

const ComputerOperationSchema: Schema.Codec<ComputerOperation> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(COMPUTER_OPERATION.unlabelled) }),
  Schema.Struct({
    kind: Schema.Literal(COMPUTER_OPERATION.labelled),
    label: Schema.String,
    delivery: Schema.Literals(Object.values(COMPUTER_DELIVERY)),
    feedback: FeedbackSchema
  })
])

const ComputerSessionSchema: Schema.Codec<ComputerSession> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(COMPUTER_SESSION.unclaimed) }),
  Schema.Struct({
    kind: Schema.Literal(COMPUTER_SESSION.claimed),
    session_id: Schema.String,
    target: Schema.String,
    application: ComputerAppSchema,
    operation: ComputerOperationSchema,
    preview: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(COMPUTER_PREVIEW.empty) }),
      Schema.Struct({
        kind: Schema.Literal(COMPUTER_PREVIEW.captured),
        id: Schema.String,
        captured_at: Schema.Number,
        surface: Schema.String
      })
    ])
  })
])

export const ComputerStatusSchema: Schema.Codec<ComputerStatus> = Schema.Struct({
  mode: Schema.Literals(Object.values(COMPUTER_MODE)),
  foreground_allowed: Schema.Boolean,
  session: ComputerSessionSchema,
  activity: Schema.Literals(Object.values(COMPUTER_ACTIVITY))
})

export const ComputerPreviewSchema: Schema.Codec<ComputerPreview> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(COMPUTER_PREVIEW.empty) }),
  Schema.Struct({
    kind: Schema.Literal(COMPUTER_PREVIEW.captured),
    id: Schema.String,
    session_id: Schema.String,
    captured_at: Schema.Number,
    data_url: Schema.String,
    width: Schema.Number,
    height: Schema.Number
  })
])

export const ComputerStepSchema: Schema.Codec<ComputerStep> = Schema.Struct({
  kind: Schema.Literals(Object.values(COMPUTER_STEP)),
  title: Schema.String,
  app: ComputerAppSchema,
  window: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(COMPUTER_WINDOW.untitled) }),
    Schema.Struct({ kind: Schema.Literal(COMPUTER_WINDOW.titled), title: Schema.String })
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
