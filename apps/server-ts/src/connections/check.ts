import { Effect } from "effect"

import { googleConnectionCheck } from "../google/recovery.js"
import { mcpConnectionCheck } from "../mcp/recovery.js"
import type { ConnectionCheck, ConnectionProvider } from "./recovery.js"

export const connectionChecks: Effect.Effect<
  ConnectionCheck,
  never,
  Effect.Services<typeof googleConnectionCheck> | Effect.Services<typeof mcpConnectionCheck>
> = Effect.gen(function* () {
  const checks: Record<ConnectionProvider, ConnectionCheck> = {
    google: yield* googleConnectionCheck,
    mcp: yield* mcpConnectionCheck
  }
  return (decision) => checks[decision.provider](decision)
})
