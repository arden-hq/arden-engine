import { decoderFor } from "../common/boundary.js"
import {
  BrowserScopeSchema,
  BrowserScopeInputSchema,
  BrowserScopeSnapshotSchema
} from "./schema.js"

export type BrowserScope = typeof BrowserScopeSchema.Type
export type BrowserScopeInput = typeof BrowserScopeInputSchema.Type
export type BrowserScopeSnapshot = typeof BrowserScopeSnapshotSchema.Type
export const browserScopeDecoder = decoderFor(BrowserScopeSnapshotSchema, "Invalid browser scope")
