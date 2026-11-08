import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import {
  BrowserProcedureListSchema,
  BrowserProcedureDetailSchema,
  BrowserProcedureEnabledSchema,
  BrowserProcedureMutationSchema
} from "@arden-hq/protocol/effect/browser-procedures"

const errors = [HttpApiError.InternalServerErrorNoContent, HttpApiError.NotFoundNoContent] as const
export class BrowserProceduresApi extends HttpApiGroup.make("browserProcedures", {
  topLevel: true
}).add(
  HttpApiEndpoint.get("list", "/browser-procedures", {
    success: BrowserProcedureListSchema,
    error: errors
  }),
  HttpApiEndpoint.patch("settings", "/browser-procedures/settings", {
    payload: BrowserProcedureEnabledSchema,
    success: BrowserProcedureMutationSchema,
    error: errors
  }),
  HttpApiEndpoint.get("detail", "/browser-procedures/:id", {
    params: { id: Schema.String },
    success: BrowserProcedureDetailSchema,
    error: errors
  }),
  HttpApiEndpoint.patch("enable", "/browser-procedures/:id", {
    params: { id: Schema.String },
    payload: BrowserProcedureEnabledSchema,
    success: BrowserProcedureMutationSchema,
    error: errors
  })
) {}
