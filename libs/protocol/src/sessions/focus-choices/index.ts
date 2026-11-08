import { decoderFor, makeEncoder, runBoundary } from "../../common/boundary.js"
import type { ResolveFocusChoiceInput } from "./contracts.js"
import {
  FocusChoiceSchema,
  ResolveFocusChoiceResponseSchema,
  encodeResolveFocusChoiceRequestEffect
} from "./schema.js"
import { encodeFocusChoicePathEffect, encodeFocusChoiceResolvePathEffect } from "./routes.js"

export * from "./contracts.js"

export const focusChoiceDecoders = {
  choice: decoderFor(FocusChoiceSchema, "Invalid Focus choice"),
  resolve: decoderFor(ResolveFocusChoiceResponseSchema, "Invalid Focus choice resolution")
} as const

export const focusChoiceRequests = {
  resolve: makeEncoder<ResolveFocusChoiceInput>(
    encodeResolveFocusChoiceRequestEffect,
    "Invalid Focus choice resolution request"
  )
} as const

export const focusChoiceRoutes = {
  item(spaceId: string, questionId: string): string {
    return runBoundary(
      encodeFocusChoicePathEffect({ spaceId, questionId }),
      "Invalid Focus choice route",
      "encode"
    )
  },
  resolve(spaceId: string, questionId: string): string {
    return runBoundary(
      encodeFocusChoiceResolvePathEffect({ spaceId, questionId }),
      "Invalid Focus choice resolution route",
      "encode"
    )
  }
} as const
