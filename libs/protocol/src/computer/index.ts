import { Schema } from "effect"
import { decoderFor } from "../common/boundary.js"
import {
  ComputerStatusSchema,
  ComputerPreviewSchema,
  ComputerStepSchema,
  ComputerSetupSchema
} from "./schema.js"
export type {
  ComputerStatus,
  ComputerPreview,
  ComputerFeedback,
  ComputerStep,
  ComputerFrame
} from "./contracts.js"
export type { ComputerSetup } from "./contracts.js"
/** A result's `computer` step; older results and failed calls carry none. */
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
} as const
