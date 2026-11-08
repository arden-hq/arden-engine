import {
  StorageBackfillsSchema,
  StorageCleanupContextRequestSchema,
  StorageCleanupPlanResponseSchema,
  StorageCleanupRequestSchema,
  StorageCleanupRunResponseSchema,
  StorageFilesSchema,
  StorageOverviewResponseSchema,
  StorageRetentionSchema,
  StorageSettingsPatchRequestSchema
} from "@arden-hq/protocol/effect/storage"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { storeErrors } from "../errors.js"

export class StorageApi extends HttpApiGroup.make("storage", { topLevel: true }).add(
  HttpApiEndpoint.get("backfills", "/storage/backfills", {
    success: StorageBackfillsSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("files", "/storage/files", {
    success: StorageFilesSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("retention", "/storage/retention", {
    success: StorageRetentionSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.put("updateRetention", "/storage/retention", {
    payload: StorageRetentionSchema,
    success: StorageRetentionSchema,
    error: [HttpApiError.BadRequestNoContent, HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.get("overview", "/storage", {
    success: StorageOverviewResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("tidy", "/storage/tidy", {
    success: StorageOverviewResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.patch("updateSettings", "/storage/settings", {
    payload: StorageSettingsPatchRequestSchema,
    success: StorageOverviewResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("previewCleanup", "/storage/cleanup/preview", {
    payload: StorageCleanupContextRequestSchema,
    success: StorageCleanupPlanResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("executeCleanup", "/storage/cleanup", {
    payload: StorageCleanupRequestSchema,
    success: StorageCleanupRunResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  })
) {}
