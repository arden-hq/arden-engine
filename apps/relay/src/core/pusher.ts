import type { ApnsEnvironment } from "@arden-hq/relay-protocol"

export interface PushRequest {
  readonly mac: string
  readonly dev: string
  readonly token: string
  readonly env: ApnsEnvironment
  readonly topic: string
  readonly collapseId: string
  readonly priority: "high" | "normal"
  readonly body: Uint8Array
}

export type PushResult =
  | { readonly status: "accepted" }
  | { readonly status: "rejected" | "unavailable"; readonly reason: string }

export interface Pusher {
  push(request: PushRequest): Promise<PushResult>
}

export const noopPusher: Pusher = {
  push: () => Promise.resolve({ status: "unavailable", reason: "NotConfigured" })
}
