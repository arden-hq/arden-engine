export type ProtocolErrorKind = "decode" | "encode" | "stream" | "api"

export class ProtocolError extends Error {
  readonly code = "protocol_error" as const
  readonly kind: ProtocolErrorKind

  constructor(message: string, options: { readonly kind: ProtocolErrorKind }) {
    super(message)
    this.name = "ProtocolError"
    this.kind = options.kind
  }
}
