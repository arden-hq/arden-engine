import { ToolExecutionError } from "@arden-hq/loop"
import { Schema } from "effect"

import {
  displayLocalPath,
  LocalRevisionConflict,
  type LocalPathPolicy,
  type LocalPathServices,
  policyPathOptions,
  resolveLocalPath,
  sessionPathPolicy
} from "../storage/local-paths.js"
import { RipgrepSearchError } from "./ripgrep.js"
import type { ServerRunContext } from "./run-context.js"
import { toolFault, toolRefusal } from "./tool-failure.js"

export const PathSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096)
).annotate({ description: "File or directory path. Relative paths use the current Local folder." })

export const filesystemError = (
  cause: unknown,
  action: string,
  target: string
): ToolExecutionError => {
  if (cause instanceof ToolExecutionError) return cause
  if (cause instanceof RipgrepSearchError) {
    return toolFault(
      cause.reason === "timeout"
        ? `File search timed out under ${target}. Narrow the path, glob, or query.`
        : `File search produced too much output under ${target}. Narrow the path, glob, or query.`,
      cause.reason === "timeout" ? "Search timed out" : "Search too broad"
    )
  }
  if (cause instanceof LocalRevisionConflict) {
    return toolRefusal(
      `File changed after it was reviewed: ${target}. Read it again and retry.`,
      "File changed"
    )
  }
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  if (code === "EACCES" || code === "EPERM") {
    return toolRefusal(
      `Permission denied while trying to ${action} ${target}.`,
      "Permission denied"
    )
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return toolRefusal(`Path not found: ${target}.`, "Not found")
  }
  return toolFault(`Could not ${action} ${target}.`, `${action} failed`)
}

export const cwdFor = (
  services: LocalPathServices,
  ctx: { readonly run: ServerRunContext; readonly signal: AbortSignal }
) =>
  sessionPathPolicy(services, {
    sessionId: ctx.run.sessionId,
    runId: ctx.run.runId,
    signal: ctx.signal
  })

export const resolveFor = (
  policy: LocalPathPolicy,
  target: string,
  options: { readonly allowMissing?: boolean; readonly mutation?: boolean } = {}
) => resolveLocalPath(target, policy.cwd, { ...options, ...policyPathOptions(policy) })

export const displayFor = (policy: LocalPathPolicy, target: string): string =>
  displayLocalPath(target, policy.cwd)
