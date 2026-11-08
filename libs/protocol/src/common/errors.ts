import { Effect, Schema } from "effect"

import { ApiErrorEnvelopeSchema } from "./schema.js"
import type { JsonRecord } from "./json.js"

export interface ApiValidationIssue extends JsonRecord {
  readonly type?: string
  readonly loc?: ReadonlyArray<string | number>
  readonly msg?: string
  readonly input?: unknown
  readonly ctx?: JsonRecord
}

/** The error envelope emitted by Arden routes. */
export interface ApiErrorEnvelope extends JsonRecord {
  readonly detail?: string | JsonRecord | ReadonlyArray<ApiValidationIssue>
  readonly message?: string
  readonly code?: string
  readonly debug_id?: string | null
  readonly status?: number
}

export type ProtocolErrorKind = "decode" | "encode" | "stream" | "api"

/** Plain boundary error. Backend-specific exceptions stay behind the package. */
export class ProtocolError extends Error {
  readonly code = "protocol_error" as const
  readonly kind: ProtocolErrorKind
  readonly status?: number
  readonly envelope?: ApiErrorEnvelope

  constructor(
    message: string,
    options: {
      readonly kind?: ProtocolErrorKind
      readonly status?: number
      readonly envelope?: ApiErrorEnvelope
    } = {}
  ) {
    super(message)
    this.name = "ProtocolError"
    this.kind = options.kind ?? "decode"
    if (options.status !== undefined) this.status = options.status
    if (options.envelope !== undefined) this.envelope = options.envelope
  }
}

/** Decode an API error body without exposing Effect or Pydantic types. */
export function decodeApiErrorEnvelope(value: unknown): ApiErrorEnvelope {
  try {
    return Effect.runSync(Schema.decodeUnknownEffect(ApiErrorEnvelopeSchema)(value))
  } catch {
    throw new ProtocolError("Invalid API error envelope", { kind: "api" })
  }
}

/** Normalize a server error body into the package's plain error boundary. */
export function normalizeApiError(value: unknown, status?: number): ProtocolError {
  try {
    const envelope = decodeApiErrorEnvelope(value)
    const detail = envelope.detail
    let message = envelope.message ?? envelope.code ?? "API request failed"
    if (typeof detail === "string") {
      message = detail
    } else if (Array.isArray(detail)) {
      const issues = detail
        .map((issue) => issue.msg ?? issue.type)
        .filter((item): item is string => typeof item === "string" && item.length > 0)
      if (issues.length > 0) message = issues.join("; ")
    } else if (
      detail !== undefined &&
      detail !== null &&
      !Array.isArray(detail) &&
      typeof detail === "object"
    ) {
      const detailObject = detail as JsonRecord
      const detailMessage =
        detailObject["message"] ?? detailObject["detail"] ?? detailObject["code"]
      if (typeof detailMessage === "string" && detailMessage.length > 0) message = detailMessage
    }
    const resolvedStatus = status ?? envelope.status
    return resolvedStatus === undefined
      ? new ProtocolError(message, { kind: "api", envelope })
      : new ProtocolError(message, { kind: "api", status: resolvedStatus, envelope })
  } catch {
    return status === undefined
      ? new ProtocolError("Invalid API error envelope", { kind: "api" })
      : new ProtocolError("Invalid API error envelope", { kind: "api", status })
  }
}
