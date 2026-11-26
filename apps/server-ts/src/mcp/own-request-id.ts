const OWN_ID_PREFIX = "arden-mcp-"

export const RESPONSE_OWNER = { channel: "channel", client: "client" } as const

export type ResponseOwner =
  | { readonly kind: typeof RESPONSE_OWNER.channel; readonly id: string }
  | { readonly kind: typeof RESPONSE_OWNER.client }

export const ownRequestId = (sequence: number): string => `${OWN_ID_PREFIX}${sequence}`

export const responseOwner = (id: unknown): ResponseOwner =>
  typeof id === "string" && id.startsWith(OWN_ID_PREFIX)
    ? { kind: RESPONSE_OWNER.channel, id }
    : { kind: RESPONSE_OWNER.client }
