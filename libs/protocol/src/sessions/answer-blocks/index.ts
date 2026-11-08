import { decoderFor, makeEncoder, runBoundary } from "../../common/boundary.js"
import type { SaveAnswerBlockInput } from "./contracts.js"
import {
  AnswerBlockStatesSchema,
  SavedAnswerBlockSchema,
  encodeSaveAnswerBlockRequestEffect
} from "./schema.js"
import { encodeAnswerBlockPathEffect, encodeAnswerBlockStatesPathEffect } from "./routes.js"

export * from "./contracts.js"

export const answerBlockDecoders = {
  states: decoderFor(AnswerBlockStatesSchema, "Invalid answer block values"),
  saved: decoderFor(SavedAnswerBlockSchema, "Invalid saved answer block")
} as const

export const answerBlockRequests = {
  save: makeEncoder<SaveAnswerBlockInput>(
    encodeSaveAnswerBlockRequestEffect,
    "Invalid answer block values request"
  )
} as const

export const answerBlockRoutes = {
  states(sessionId: string): string {
    return runBoundary(
      encodeAnswerBlockStatesPathEffect(sessionId),
      "Invalid answer block values route",
      "encode"
    )
  },
  block(sessionId: string, messageId: string, blockIndex: number): string {
    return runBoundary(
      encodeAnswerBlockPathEffect({ sessionId, messageId, blockIndex }),
      "Invalid answer block route",
      "encode"
    )
  }
} as const
