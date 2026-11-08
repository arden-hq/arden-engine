import { DateTime, Effect } from "effect"
import type { ChatRunRecord } from "../../src/persistence/runs/model.js"
import type { LocalPathServices } from "../../src/storage/local-paths.js"
import type { RunRules } from "../../src/execution/rules.js"
import type { PermissionRules } from "../../src/persistence/permissions/rules.js"
import { partialService, runAuthority } from "../kit.js"

export const localRunAuthority = (
  records: ReadonlyArray<{
    readonly sessionId: string
    readonly runId: string
    readonly spaceId: string | null
    readonly authoritySessionId?: string
  }>
): LocalPathServices["runs"] => {
  const startedAt = DateTime.makeUnsafe("2026-09-05T00:00:00.000Z")
  const runs = new Map(
    records.map((record) => [
      record.runId,
      {
        runId: record.runId,
        sessionId: record.sessionId,
        turnId: "fixture-turn",
        status: "running",
        startedAt,
        updatedAt: startedAt,
        endedAt: null,
        stopReason: null,
        lastSequence: null,
        errorCode: null,
        errorMessage: null,
        clientId: null,
        modelId: null,
        reasoningEffort: null,
        metadata: {
          run_policy: {
            ...(record.authoritySessionId === undefined
              ? {}
              : { authority_session_id: record.authoritySessionId }),
            budget_id: record.runId,
            budget_generation: 0,
            execution: { mode: "worker", observe: false },
            capabilities: ["all"],
            auto_approve: false,
            google_accounts: null,
            space:
              record.spaceId === null
                ? null
                : {
                    space_id: record.spaceId,
                    generation: 0,
                    execution: "on_request",
                    inference: { enabled: false }
                  }
          }
        }
      } satisfies ChatRunRecord
    ])
  )
  const spaces = new Map(records.map((record) => [record.runId, record.spaceId]))
  return {
    get: (runId) => Effect.succeed(runs.get(runId) ?? null),
    authority: (runId) => {
      const spaceId = spaces.get(runId)
      return Effect.succeed(
        spaceId === undefined
          ? undefined
          : runAuthority({ owns: { ...runAuthority().owns, space_id: spaceId } })
      )
    }
  }
}

export const NO_PATH_RULES: RunRules = { own: undefined, rules: [] }

export const NO_RULES: PermissionRules["Service"] = partialService<PermissionRules["Service"]>(
  "PermissionRules",
  { inLists: () => Effect.succeed([]) }
)
