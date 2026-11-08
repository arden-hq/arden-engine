import { Effect } from "effect"

import type { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"

export const sessionLifecycleFixture = {
  appendBlockingWorkInTransaction: () => Effect.succeed({ records: [], headSequence: 0 })
} satisfies Pick<SessionLifecycleEvents["Service"], "appendBlockingWorkInTransaction">
