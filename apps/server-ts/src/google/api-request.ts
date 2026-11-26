import type { GoogleServiceId } from "@arden-hq/protocol/google"

export interface GoogleAccountAccess {
  readonly allowedAccountIds: () => Promise<ReadonlyArray<string> | null>
}

export const GOOGLE_RESPONSE_MODE = { binary: "binary" } as const

export interface GoogleApiRequest {
  readonly service: GoogleServiceId
  readonly url: string
  readonly init?: RequestInit | undefined
  readonly accountRef?: string | undefined
  readonly access?: GoogleAccountAccess | undefined
  readonly response?: {
    readonly kind: typeof GOOGLE_RESPONSE_MODE.binary
    readonly maxBytes: number
  }
}
