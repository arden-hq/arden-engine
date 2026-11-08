import { decoderFor, makeEncoder, runBoundary } from "../../common/boundary.js"
import type { TerminalInputRequest } from "./contracts.js"
import {
  encodeTerminalInputRequestEffect,
  SessionTerminalsResponseSchema,
  TerminalActionResponseSchema,
  TerminalInputResponseSchema,
  TerminalOutputResponseSchema
} from "./schema.js"
import {
  encodeTerminalOutputPathEffect,
  encodeTerminalPathEffect,
  encodeTerminalsPathEffect
} from "./routes.js"

export * from "./contracts.js"

export const terminalDecoders = {
  list: decoderFor(SessionTerminalsResponseSchema, "Invalid terminals response"),
  output: decoderFor(TerminalOutputResponseSchema, "Invalid terminal output response"),
  input: decoderFor(TerminalInputResponseSchema, "Invalid terminal input response"),
  action: decoderFor(TerminalActionResponseSchema, "Invalid terminal action response")
} as const

export const terminalRequests = {
  input: makeEncoder<TerminalInputRequest>(
    encodeTerminalInputRequestEffect,
    "Invalid terminal input request"
  )
} as const

/** The terminal path serves DELETE; `/stop` and `/input` take POST. */
export const terminalRoutes = {
  list(sessionId: string): string {
    return runBoundary(encodeTerminalsPathEffect(sessionId), "Invalid terminals route", "encode")
  },
  item(sessionId: string, terminalId: number, suffix: "" | "/stop" | "/input" = ""): string {
    return runBoundary(
      encodeTerminalPathEffect({ sessionId, terminalId }, suffix),
      "Invalid terminal route",
      "encode"
    )
  },
  output(sessionId: string, terminalId: number, after: number): string {
    return runBoundary(
      encodeTerminalOutputPathEffect({ sessionId, terminalId }, after),
      "Invalid terminal output route",
      "encode"
    )
  }
} as const
