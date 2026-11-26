import { RunContextSchema, type RunContext } from "../persistence/runs/stored-context.js"
import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import type { MemoryAuthority, RunAuthority } from "../execution/authority.js"
import { refusalError } from "./refusal.js"
import { systemHandlerForAutomation } from "../automations/system.js"
import { AutomationId } from "../persistence/automations/model.js"
import type { ChatRunRecord } from "../persistence/runs/model.js"
import type { RunCause, RunQueries } from "../persistence/runs/queries.js"
import {
  MemoryCaptureBatchIdentitySchema,
  type MemoryCaptureBatchIdentity
} from "../persistence/memory/store.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY, type WikiLocationAuthority } from "../wiki/authority.js"
import { automationOrigin, upkeepOrigin, type WikiCommitOrigin } from "../wiki/origin.js"

export interface WikiRunIdentityContext {
  readonly runId: string
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly authority: RunAuthority
}

export interface WikiWriteIdentity {
  readonly actor: string
  readonly origin: WikiCommitOrigin
  readonly captureBatch: MemoryCaptureBatchIdentity | null
  readonly authority: WikiLocationAuthority
}

const readRun = async (
  runs: Pick<RunQueries["Service"], "get">,
  runId: string,
  signal: AbortSignal
): Promise<{ readonly record: ChatRunRecord | null; readonly context: RunContext | null }> => {
  const record = await Effect.runPromise(
    runs.get(runId).pipe(
      Effect.mapError(
        (cause) =>
          new ToolExecutionError(
            `Could not resolve this Run's writing identity: ${cause.message}`,
            {
              preview: "Memory write identity unavailable",
              retryable: cause._tag === "RunQueryError"
            }
          )
      )
    ),
    { signal }
  )
  if (record === null || record.runId !== runId) return { record: null, context: null }
  const context = await Effect.runPromise(
    Schema.decodeUnknownEffect(RunContextSchema)(record.metadata["run_context"]).pipe(
      Effect.mapError(() => identityUnavailable("This Run's admitted origin is invalid."))
    ),
    { signal }
  )
  return { record, context }
}

export const readWikiRun = async (
  runs: Pick<RunQueries["Service"], "get">,
  input: WikiRunIdentityContext
): Promise<{ readonly record: ChatRunRecord; readonly context: RunContext }> => {
  const { record, context } = await readRun(runs, input.runId, input.signal)
  if (record === null || context === null || record.sessionId !== input.sessionId) {
    throw identityUnavailable("This Run has no matching durable writing identity.")
  }
  return { record, context }
}

export const memoryLocation = (memory: MemoryAuthority): WikiLocationAuthority => {
  switch (memory._tag) {
    case "Global":
    case "Capture":
      return GLOBAL_WIKI_LOCATION_AUTHORITY
    case "Space":
      return { _tag: "Space", spaceId: memory.space_id }
    case "None":
      throw refusalError({
        what: "This run may not write Memory",
        rule: "boundary",
        instead: [{ kind: "report" }]
      })
  }
}

export const writeIdentity = async (
  runs: Pick<RunQueries["Service"], "get" | "cause">,
  input: WikiRunIdentityContext
): Promise<WikiWriteIdentity> => {
  const identity = await admittedIdentity(runs, input)
  return { ...identity, authority: memoryLocation(input.authority.memory) }
}

export const readRunCause = (
  runs: Pick<RunQueries["Service"], "cause">,
  input: Pick<WikiRunIdentityContext, "runId" | "signal">
): Promise<RunCause> =>
  Effect.runPromise(
    runs.cause(input.runId).pipe(
      Effect.mapError(
        (cause) =>
          new ToolExecutionError(`Could not resolve who caused this Run: ${cause.message}`, {
            preview: "Memory write identity unavailable",
            retryable: true
          })
      )
    ),
    { signal: input.signal }
  )

const automationWriter = (cause: RunCause & { readonly automationId: string }) => {
  const upkeep =
    systemHandlerForAutomation(AutomationId.make(cause.automationId))?.spec.handler ===
    "wiki_maintenance"
  return {
    actor: `Automation ${cause.automationId}`,
    origin: upkeep
      ? upkeepOrigin(cause.automationId, cause.wakeDepth)
      : automationOrigin(cause.automationId, cause.wakeDepth),
    captureBatch: null
  }
}

export const agentOrigin = (sessionId: string, cause: RunCause): WikiCommitOrigin => ({
  kind: "agent",
  sessionId,
  chainDepth: cause.wakeDepth
})

const admittedIdentity = async (
  runs: Pick<RunQueries["Service"], "get" | "cause">,
  input: WikiRunIdentityContext
): Promise<Omit<WikiWriteIdentity, "authority">> => {
  const { record, context } = await readWikiRun(runs, input)
  if (context.origin.kind === "unrecorded")
    throw identityUnavailable("This Run's writing origin was not recorded.")
  if (
    context.origin.kind === "automation" &&
    systemHandlerForAutomation(AutomationId.make(context.origin.automation_id))?.spec.handler ===
      "memory_capture"
  ) {
    const captureBatch = await Effect.runPromise(
      Schema.decodeUnknownEffect(MemoryCaptureBatchIdentitySchema)(
        record.metadata["memory_capture_batch"]
      ).pipe(
        Effect.mapError(() =>
          identityUnavailable("This Memory Capture Run has no durable source batch identity.")
        )
      ),
      { signal: input.signal }
    )
    return {
      actor: "memory:capture",
      origin: { kind: "capture", sessionId: captureBatch.sessionId },
      captureBatch
    }
  }
  const cause = await readRunCause(runs, input)
  if (cause.automationId !== undefined)
    return automationWriter({ ...cause, automationId: cause.automationId })
  if (context.origin.kind !== "chat")
    throw identityUnavailable("This Run's Automation is no longer recorded.")
  return {
    actor: "Agent",
    origin: agentOrigin(input.sessionId, cause),
    captureBatch: null
  }
}

const identityUnavailable = (message: string): ToolExecutionError =>
  new ToolExecutionError(message, {
    preview: "Memory write identity unavailable",
    retryable: false
  })
