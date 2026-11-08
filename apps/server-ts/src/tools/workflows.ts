import { cutText } from "@arden-hq/std/text"
import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import type { ScriptDetail } from "@arden-hq/protocol/workflows"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import type { ServerRunContext } from "./run-context.js"
import { ScriptJournal } from "../persistence/scripts/journal.js"
import { ScriptResults } from "../persistence/scripts/results.js"
import { ScriptStore, ScriptStoreError, type ScriptRecord } from "../persistence/scripts/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import {
  ScriptAccessError,
  readOwnedScript,
  scriptDetail,
  scriptSummary
} from "../workflows/access.js"
import { ScriptRunner, statusLine } from "../workflows/script-runner.js"
import { WORKFLOW_CANCEL_TOOL, WORKFLOW_RETRY_TOOL } from "../persistence/tools/tool-roles.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt } from "./call-receipt.js"
import { actsAsPerson, sharedResourceSessions } from "../execution/authority.js"
import { toolFailure } from "./tool-failure.js"

const WorkflowRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512)).pipe(
  Schema.annotateEncoded({
    description:
      "The script's reference (wf-…) from the code_mode call that moved to the background."
  })
)

const GetParametersSchema = Schema.Struct({ workflow_ref: WorkflowRefSchema })

const RetryParametersSchema = Schema.Struct({
  workflow_ref: WorkflowRefSchema,
  expected_version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The script's current version, as workflow_get returned it."
  })
})

const CancelParametersSchema = Schema.Struct({ workflow_ref: WorkflowRefSchema })

interface ScriptToolServices {
  readonly store: ScriptStore["Service"]
  readonly journal: ScriptJournal["Service"]
  readonly results: ScriptResults["Service"]
  readonly runner: ScriptRunner["Service"]
  readonly sessions: SessionQueries["Service"]
}

const MAX_RESULT_LENGTH = 4_000

const failure = (error: unknown): ToolExecutionError => {
  if (error instanceof ScriptAccessError) {
    return new ToolExecutionError(error.message, {
      preview: "Script unavailable",
      retryable: false
    })
  }
  if (error instanceof ScriptStoreError) {
    return toolFailure(
      error,
      error.reason === "unsafe_retry" ? "Needs review" : "Script unavailable"
    )
  }
  return new ToolExecutionError("The script could not be read", {
    preview: "Script unavailable",
    retryable: true
  })
}

const run = <A>(effect: Effect.Effect<A, unknown>, signal: AbortSignal): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.mapError(failure)), { signal })

const owned = async (
  services: ScriptToolServices,
  ctx: ToolContext<ServerRunContext>,
  ref: string
): Promise<ScriptRecord> => {
  const allowedSessionRefs = (
    await Promise.all(
      sharedResourceSessions(ctx.run.authority, "agent_code").map(async (resource) => {
        const session = await Effect.runPromise(
          services.sessions.loadHistoryHeader(resource.session_id),
          {
            signal: ctx.signal
          }
        )
        return session?.publicRef
      })
    )
  ).filter((sessionRef): sessionRef is string => sessionRef !== undefined)
  return run(
    readOwnedScript({
      store: services.store,
      sessions: services.sessions,
      ref,
      sessionId: ctx.run.sessionId,
      allowedSessionRefs
    }),
    ctx.signal
  )
}

const workflowResource = (record: ScriptRecord, state: string) => ({
  kind: "target" as const,
  resourceRef: `workflow:${record.ref}`,
  domain: "other" as const,
  title: `Workflow ${state}`,
  href: `arden:session/${encodeURIComponent(record.originSessionRef)}`
})

const formatScript = (detail: ScriptDetail, result: string | undefined): string => {
  const { script } = detail
  const lines = [
    `Script ${script.workflow_ref}: status=${script.status}; attempt=${script.attempt}; version=${script.version}; started=${script.created_at}; ended=${script.ended_at ?? "-"}.`,
    ...(script.error === null ? [] : [`Error: ${JSON.stringify(script.error)}`]),
    ...detail.agents.map(
      (agent) =>
        `- Agent ${JSON.stringify(agent.label)}: ${agent.status}; mode=${agent.mode ?? "-"}; session_ref=${agent.session_ref}`
    )
  ]
  if (result !== undefined) {
    lines.push(`Result of attempt ${script.attempt}:`, cutText(result, MAX_RESULT_LENGTH))
  }
  return lines.join("\n")
}

const makeWorkflowTools = (services: ScriptToolServices): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "workflow_get",
    description:
      "Read one script that moved to the background: its status, attempt, version, the error that stopped it, each agent's status and session, and its result once it settled.",
    parameters: Schema.toStandardSchemaV1(GetParametersSchema),
    metadata: {
      effect: "none",
      code_mode: false,
      display_name: "Get Workflow",
      kind: "tool",
      action: "read",
      approval_preview: "Check on a multi-step job.",
      source: "_agents",
      changes_state: false,
      concurrency_group: "workflow_control",
      destructive: false,
      idempotent: true
    },
    execute: async (input, ctx) => {
      const record = await owned(services, ctx, input.workflow_ref)
      const detail = await run(scriptDetail(services.journal, record), ctx.signal)
      const result =
        record.status === "running"
          ? undefined
          : await run(
              services.results.text({ workflowRef: record.ref, attempt: record.attempt }),
              ctx.signal
            )
      return {
        result: formatScript(detail, result),
        preview: record.status,
        data: detail
      }
    }
  }),
  defineServerTool({
    name: WORKFLOW_RETRY_TOOL,
    description: [
      "Run a settled script again from the start, on the chat run it began on.",
      "Use the version from workflow_get. Agents and calls that succeeded are reused; failed ones that changed nothing run again. A retry is refused while an earlier step may have changed something outside Arden: review that first."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(RetryParametersSchema),
    metadata: {
      effect: "arden_db",
      detached: true,
      code_mode: false,
      display_name: "Retry Workflow",
      kind: "tool",
      action: "execute",
      approval_preview: "Run a multi-step job again.",
      source: "_agents",
      changes_state: true,
      target: "reported",
      concurrency_group: "workflow_control",
      destructive: false,
      idempotent: true
    },
    execute: async (input, ctx, effects) => {
      const record = await owned(services, ctx, input.workflow_ref)
      if (ctx.run.runId !== record.originRunId && !actsAsPerson(ctx.run.authority.actor)) {
        throw new ToolExecutionError(
          "Only the chat run that started this script, or the person, can run it again",
          { preview: "Retry not allowed", retryable: false }
        )
      }
      const origin = await ctx.run
        .detachedRun({ sessionId: record.originSessionId, runId: record.originRunId })
        .catch(() => {
          throw new ToolExecutionError("The script's chat run could not be rebuilt", {
            preview: "Script unavailable",
            retryable: true
          })
        })
      const retried = await recordApplied(
        effects,
        run(
          services.runner.retry({
            ref: record.ref,
            expectedVersion: input.expected_version,
            binding: { run: origin, host: ctx.run.scriptHostFor(origin) }
          }),
          ctx.signal
        )
      )
      return {
        result: `Script ${retried.ref} is running again as attempt ${retried.attempt}. Its result arrives here automatically.`,
        preview: "Script running again",
        data: scriptSummary(retried),
        host: appliedReceipt(ctx, workflowResource(retried, "retried"))
      }
    }
  }),
  defineServerTool({
    name: WORKFLOW_CANCEL_TOOL,
    description: "Stop a script that is still running, and its agents.",
    parameters: Schema.toStandardSchemaV1(CancelParametersSchema),
    metadata: {
      effect: "arden_db",
      code_mode: false,
      display_name: "Cancel Workflow",
      kind: "tool",
      action: "write",
      approval_preview: "Stop a multi-step job.",
      source: "_agents",
      changes_state: true,
      target: "reported",
      concurrency_group: "workflow_control",
      destructive: true,
      idempotent: true
    },
    execute: async (input, ctx, effects) => {
      const record = await owned(services, ctx, input.workflow_ref)
      const cancelled = await run(
        services.runner.cancel({ ref: record.ref, cancelAgent: ctx.run.cancelAgent }),
        ctx.signal
      )
      const stopped = record.status === "running" && cancelled.status === "cancelled"
      if (stopped) effects.applied()
      else effects.unchanged()
      return {
        result: `Script ${cancelled.ref} is ${cancelled.status}.`,
        preview: statusLine(cancelled.status),
        data: scriptSummary(cancelled),
        ...(stopped ? { host: appliedReceipt(ctx, workflowResource(cancelled, "cancelled")) } : {})
      }
    }
  })
]

export const workflowTools = Effect.gen(function* () {
  return makeWorkflowTools({
    store: yield* ScriptStore,
    journal: yield* ScriptJournal,
    results: yield* ScriptResults,
    runner: yield* ScriptRunner,
    sessions: yield* SessionQueries
  })
})
