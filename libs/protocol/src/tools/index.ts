import { projectedDecoderFor } from "../common/boundary.js"
import { ToolCatalogResponseSchema, toToolCatalogResponse } from "./schema.js"

export {
  grantedOnlyInTheApp,
  LEGACY_TOOL_DISPLAY,
  TOOL_DISPLAY_APP,
  TOOL_DISPLAY_CARD,
  TOOL_DISPLAY_FACTS,
  TOOL_DISPLAY_MAIL,
  TOOL_DISPLAY_REFRESH,
  TOOL_DISPLAY_RESULT,
  TOOL_DISPLAY_ROW,
  TOOL_DISPLAY_TRAIL,
  toolDisplayFact,
  type ToolDisplay,
  type ToolDisplayApp,
  type ToolDisplayCard,
  type ToolDisplayMail,
  type ToolDisplayRefresh,
  type ToolDisplayResult,
  type ToolDisplayRow,
  type ToolDisplayTrail,
  type ToolDisplayFact
} from "./display.js"

export { TOOL_ACTION, TOOL_APPROVAL_OVERRIDE, TOOL_SCOPE } from "./contracts.js"
export type {
  ToolAction,
  ToolApprovalOverride,
  ToolCatalogEntry,
  ToolCatalogResponse,
  ToolDefaultApproval,
  ToolPolicy,
  ToolScope
} from "./contracts.js"

export const toolDecoders = {
  catalog: projectedDecoderFor(
    ToolCatalogResponseSchema,
    toToolCatalogResponse,
    "Invalid tool catalog"
  )
} as const

export const toolRoutes = {
  catalog: "/tools"
}
