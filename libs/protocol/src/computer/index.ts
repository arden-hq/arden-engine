import { Schema } from "effect"
import { decoderFor } from "../common/boundary.js"
import {
  ComputerStatusSchema,
  ComputerPreviewSchema,
  ComputerStepSchema,
  ComputerSetupSchema
} from "./schema.js"
export {
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
  COMPUTER_WINDOW
} from "./contracts.js"
export type {
  ComputerApp,
  ComputerStatus,
  ComputerOperation,
  ComputerPreview,
  ComputerPreviewRef,
  ComputerFrameCapture,
  ComputerFeedback,
  ComputerSession,
  ComputerStep,
  ComputerWindow,
  ComputerFrame
} from "./contracts.js"
export type {
  ComputerActivity,
  ComputerDelivery,
  ComputerInstallation,
  ComputerMode,
  ComputerPermissions,
  ComputerSetup,
  ComputerStepKind
} from "./contracts.js"
export const isComputerStep = Schema.is(ComputerStepSchema)
export const computerDecoders = {
  setup: decoderFor(ComputerSetupSchema, "Invalid computer setup response"),
  preview: decoderFor(ComputerPreviewSchema, "Invalid computer preview response"),
  status: decoderFor(ComputerStatusSchema, "Invalid computer control response")
}
export const computerRoutes = {
  setup: "/computer/setup",
  install: "/computer/setup/install",
  stopInstall: "/computer/setup/stop",
  permissions: "/computer/setup/permissions",
  status: "/computer",
  preview: "/computer/preview",
  pause: "/computer/pause",
  resume: "/computer/resume"
}
