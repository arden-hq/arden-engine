import {
  ComputerStatusSchema,
  ComputerPreviewSchema,
  ComputerSetupSchema
} from "@arden-hq/protocol/effect/computer"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

export class ComputerApi extends HttpApiGroup.make("computer", { topLevel: true })
  .add(HttpApiEndpoint.get("setup", "/computer/setup", { success: ComputerSetupSchema }))
  .add(
    HttpApiEndpoint.post("install", "/computer/setup/install", {
      success: ComputerSetupSchema,
      error: HttpApiError.InternalServerError
    })
  )
  .add(
    HttpApiEndpoint.post("stopInstall", "/computer/setup/stop", {
      success: ComputerSetupSchema,
      error: HttpApiError.InternalServerError
    })
  )
  .add(
    HttpApiEndpoint.post("permissions", "/computer/setup/permissions", {
      success: ComputerSetupSchema,
      error: HttpApiError.InternalServerError
    })
  )
  .add(HttpApiEndpoint.get("preview", "/computer/preview", { success: ComputerPreviewSchema }))
  .add(HttpApiEndpoint.get("status", "/computer", { success: ComputerStatusSchema }))
  .add(
    HttpApiEndpoint.post("pause", "/computer/pause", {
      success: ComputerStatusSchema,
      error: HttpApiError.InternalServerError
    })
  )
  .add(
    HttpApiEndpoint.post("resume", "/computer/resume", {
      success: ComputerStatusSchema,
      error: HttpApiError.InternalServerError
    })
  ) {}
