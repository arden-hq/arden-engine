import { projectedDecoderFor } from "../common/boundary.js"
import { ToolCatalogResponseSchema, toToolCatalogResponse } from "./schema.js"

export { LEGACY_TOOL_DISPLAY, TOOL_DISPLAY_FACTS, type ToolDisplay } from "./display.js"

export type {
  ToolAction,
  ToolApprovalOverride,
  ToolCatalogEntry,
  ToolCatalogResponse,
  ToolDefaultApproval,
  ToolPolicy,
  ToolScope
} from "./contracts.js"

/** The single plain decoder for the read-only tool catalog. */
export const toolDecoders = {
  catalog: projectedDecoderFor(
    ToolCatalogResponseSchema,
    toToolCatalogResponse,
    "Invalid tool catalog"
  )
} as const

export const toolRoutes = {
  catalog: "/tools"
} as const
