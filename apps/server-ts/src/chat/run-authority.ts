import { Effect } from "effect"
import { unrecordedAuthority, type RunAuthority } from "../execution/authority.js"
import type { RunQueries } from "../persistence/runs/queries.js"

export const boundAuthority = (
  runs: Pick<RunQueries["Service"], "authority">,
  input: { readonly runId: string; readonly sessionId: string }
): Effect.Effect<RunAuthority> =>
  runs.authority(input.runId).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.map((stored) => stored ?? unrecordedAuthority(input.sessionId))
  )
