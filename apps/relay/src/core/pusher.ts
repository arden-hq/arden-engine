import { PUSH_STATUS } from "@arden-hq/relay-protocol"
import type { ApnsEnvironment, PushOutcome, PushPriority } from "@arden-hq/relay-protocol"

export interface PushRequest {
  readonly mac: string
  readonly dev: string
  readonly token: string
  readonly env: ApnsEnvironment
  readonly topic: string
  readonly collapseId: string
  readonly priority: PushPriority
  readonly body: Uint8Array
}

export interface Pusher {
  push(request: PushRequest): Promise<PushOutcome>
}

export const noopPusher: Pusher = {
  push: () => Promise.resolve({ status: PUSH_STATUS.unavailable, reason: "NotConfigured" })
}
