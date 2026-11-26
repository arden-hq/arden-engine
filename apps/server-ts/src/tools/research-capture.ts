import { ToolExecutionError, type ToolResult } from "@arden-hq/loop"
import { Effect, Predicate } from "effect"

import { type ServerTool } from "./define.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { ResearchWorkspace } from "../research/workspace.js"
import { canonicalResearchText } from "../research/workspace-model.js"
import { ResearchWorkspaceError } from "../research/workspace-storage.js"
import { readAgentSessionMetadata } from "../sessions/agent-mode.js"
import { AGENT_MODE } from "@arden-hq/protocol/chat"
import { SESSION_TYPE } from "@arden-hq/protocol/sessions"
import { TOOL_SOURCE } from "./tool-scopes.js"
import type { ServerRunContext } from "./run-context.js"
import type { ServerToolRun } from "../chat/runner-contract.js"
import type { ToolsetMiddleware } from "../execution/toolset-middleware.js"
import { workflowOperationId } from "../workflows/identity.js"
import { readsOnly } from "../execution/impact.js"
import { toolFailure, toolFault } from "./tool-failure.js"

export const operationId = (
  ctx: {
    readonly toolCallId: string
    readonly run: Pick<ServerRunContext, "runId">
  },
  name: string
): string => workflowOperationId(ctx.run.runId, ctx.toolCallId, name)

const sourceLocator = (
  source: Readonly<Record<string, unknown>> | undefined,
  fallback: string
): string => {
  if (source === undefined) return fallback
  if (typeof source["url"] === "string" && source["url"].length > 0) return source["url"]
  if (typeof source["ref"] === "string" && source["ref"].length > 0) return source["ref"]
  return fallback
}

const sourceIdentity = (
  tool: ServerTool,
  args: Readonly<Record<string, unknown>>,
  result: ToolResult
): { readonly locator: string; readonly title: string; readonly publishedAt: string | null } => {
  const sourceRefs =
    Predicate.isObject(result.host) && Array.isArray(result.host["source_refs"])
      ? result.host["source_refs"]
      : []
  const sources = sourceRefs.filter(Predicate.isObject)
  const source = sources.length === 1 ? sources[0] : undefined
  const locator = sourceLocator(source, `${tool.definition.name}:${JSON.stringify(args)}`)
  const publishedAt =
    source !== undefined && typeof source["published_at"] === "string"
      ? source["published_at"].slice(0, 128)
      : null
  return {
    locator: locator.slice(0, 8_000),
    title: (source !== undefined && typeof source["title"] === "string"
      ? source["title"]
      : `${tool.meta.display_name} result`
    ).slice(0, 2_000),
    publishedAt
  }
}

const researchCaptureFailure = (cause: unknown): ToolExecutionError => {
  if (cause instanceof ToolExecutionError) return cause
  return cause instanceof ResearchWorkspaceError
    ? toolFailure(cause, "Research source capture failed")
    : toolFault("Research source capture failed", "Research source capture failed")
}

export const captureResearchSources = (options: {
  readonly run: Pick<ServerToolRun, "runId" | "sessionId">
  readonly tools: ReadonlyArray<ServerTool>
  readonly sessions: SessionQueries["Service"]
  readonly workspace: ResearchWorkspace["Service"]
}): ToolsetMiddleware => {
  const { run, sessions, workspace } = options
  const toolsByName = new Map(options.tools.map((tool) => [tool.definition.name, tool]))
  return {
    execute: async (request, next) => {
      const tool = toolsByName.get(request.name)
      if (
        tool === undefined ||
        !readsOnly(tool.meta) ||
        tool.meta.source === TOOL_SOURCE.research
      ) {
        return next(request)
      }
      const signal = request.signal === undefined ? undefined : { signal: request.signal }
      const snapshot = await Effect.runPromise(sessions.loadHeaderSnapshot(run.sessionId), signal)
      const agent =
        snapshot?.header.sessionType === SESSION_TYPE.agent
          ? readAgentSessionMetadata(snapshot.metadata)
          : null
      if (agent?.mode !== AGENT_MODE.research) return next(request)
      if (agent.researchWorkspaceId === null) {
        throw new ToolExecutionError(
          "This research agent has no workspace. Source reads are unavailable for every path; changing files will not repair it. Report the blocker instead of retrying other files.",
          {
            preview: "Research source capture failed",
            retryable: false
          }
        )
      }
      const result = await next(request)
      if (result.is_error === true) return result
      const source = sourceIdentity(tool, request.args, result)
      const captured = await Effect.runPromise(
        workspace.captureSource({
          workspaceId: agent.researchWorkspaceId,
          operationId: workflowOperationId(
            run.runId,
            request.toolCallId,
            "research_source_capture"
          ),
          ...source,
          text: result.content
        }),
        signal
      ).catch((cause: unknown) => {
        throw researchCaptureFailure(cause)
      })
      const snapshotRef = captured.result["snapshot_ref"]
      if (typeof snapshotRef !== "string") {
        throw new ToolExecutionError("Research source capture returned no snapshot reference", {
          preview: "Research source capture failed",
          retryable: true
        })
      }
      return {
        ...result,
        content: `${canonicalResearchText(result.content)}\n\n[Research snapshot: ${snapshotRef}; workspace revision: ${captured.revision}]`,
        host: {
          ...result.host,
          research_snapshot: {
            snapshot_ref: snapshotRef,
            revision: captured.revision
          }
        }
      }
    }
  }
}
