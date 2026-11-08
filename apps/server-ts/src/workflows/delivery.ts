import { cutText, foldSpace } from "@arden-hq/std/text"
import type { WorkflowSourceRef } from "@arden-hq/protocol/workflows"
import { Cause, Effect, Schema } from "effect"

import { errorMessage } from "@arden-hq/std/errors"
import { workflowDeliveryClientId } from "../persistence/chat/workflow-delivery.js"
import type {
  ScriptResultDelivery,
  ScriptResultError,
  ScriptResults
} from "../persistence/scripts/results.js"
import type { ChatRunnerSendMessageRequest } from "../chat/runner-contract.js"
import {
  readManagedOutputDescriptor,
  type ManagedOutputDescriptor,
  type ManagedOutputWriter
} from "../artifacts/managed-output/managed-output.js"
import { drainOutbox, pollEverySecond, runOutbox, type Outbox } from "../runtime/outbox.js"

class ScriptDeliveryError extends Schema.TaggedError<ScriptDeliveryError>()("ScriptDeliveryError", {
  message: Schema.String,
  workflowRef: Schema.NonEmptyString,
  attempt: Schema.Int,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

const MAX_DELIVERY_SOURCES = 8
const MAX_DELIVERY_SOURCE_BYTES = 8 * 1_024

interface LocalizedWorkflowSource {
  readonly source: WorkflowSourceRef
  readonly managedOutput: ManagedOutputDescriptor | null
}

const boundedField = (value: string, limit: number): string =>
  cutText(foldSpace(value), limit, { suffix: "" })

const sourceIdentity = (source: WorkflowSourceRef): Readonly<Record<string, string>> => ({
  provider: boundedField(source.provider, 64),
  kind: boundedField(source.kind, 64),
  title: boundedField(source.title, 160),
  ref: boundedField(source.ref, 512)
})

const localizeSource = async (
  source: WorkflowSourceRef,
  sessionId: string,
  outputs: ManagedOutputWriter
): Promise<LocalizedWorkflowSource> => {
  const descriptor = readManagedOutputDescriptor(source)
  if (descriptor === null) return { source, managedOutput: null }
  const copied = await outputs.copyToSession({ descriptor, sessionId })
  if (copied.descriptor === null) {
    throw new Error(`Managed Workflow source ${descriptor.sha256} could not be published`)
  }
  return { source, managedOutput: copied.descriptor }
}

const inlineSourceText = (localized: LocalizedWorkflowSource): string => {
  if (localized.source.kind === "managed_output_unavailable") {
    return `${JSON.stringify(sourceIdentity(localized.source))}\nAvailability: full output unavailable (historical source bytes missing).`
  }
  if (localized.managedOutput === null) return JSON.stringify(sourceIdentity(localized.source))
  const descriptor = localized.managedOutput
  return [
    JSON.stringify({
      ...sourceIdentity(localized.source),
      ref: descriptor.ref,
      sha256: descriptor.sha256,
      bytes: descriptor.bytes,
      format: descriptor.format
    }),
    `Use file_read with ${JSON.stringify({
      path: descriptor.ref,
      offset: 1,
      limit: 400
    })} to inspect this source.`
  ].join("\n")
}

const sourceManifest = async (
  delivery: ScriptResultDelivery,
  localized: ReadonlyArray<LocalizedWorkflowSource>,
  outputs: ManagedOutputWriter
): Promise<ManagedOutputDescriptor> => {
  const { payload } = delivery
  const manifest = JSON.stringify(
    {
      kind: "workflow_source_manifest",
      workflow_ref: payload.workflowRef,
      attempt: payload.attempt,
      source_count: localized.length,
      sources: localized.map((entry) => ({
        source: entry.source,
        ...(entry.managedOutput === null ? {} : { managed_output: entry.managedOutput })
      }))
    },
    null,
    2
  )
  const published = await outputs.localizeText({
    sessionId: payload.sessionId,
    text: manifest,
    source: {
      kind: "workflow",
      workflow_ref: payload.workflowRef,
      attempt: payload.attempt
    },
    format: "json",
    force: true
  })
  if (published.descriptor === null) {
    throw new Error("Workflow source manifest could not be published")
  }
  return published.descriptor
}

const localizedSourcesText = async (
  delivery: ScriptResultDelivery,
  outputs: ManagedOutputWriter
): Promise<string> => {
  const { sourceRefs, sessionId } = delivery.payload
  if (sourceRefs.length === 0) return ""
  const prioritized = [...sourceRefs].sort((left, right) => {
    const leftManaged = readManagedOutputDescriptor(left) === null ? 0 : 1
    const rightManaged = readManagedOutputDescriptor(right) === null ? 0 : 1
    return rightManaged - leftManaged
  })
  const localized = await Promise.all(
    prioritized.map((source) => localizeSource(source, sessionId, outputs))
  )
  const manifest = await sourceManifest(delivery, localized, outputs)
  const rendered: string[] = []
  let bytes = 0
  let omitted = Math.max(0, localized.length - MAX_DELIVERY_SOURCES)
  for (const source of localized.slice(0, MAX_DELIVERY_SOURCES)) {
    const line = `- ${inlineSourceText(source)}`
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8")
    if (bytes + lineBytes > MAX_DELIVERY_SOURCE_BYTES) {
      omitted += 1
      continue
    }
    rendered.push(line)
    bytes += lineBytes
  }
  if (omitted > 0) rendered.push(`- ${omitted} additional sources omitted from Chat.`)
  return [
    "",
    "",
    `Source manifest: ${JSON.stringify({
      ref: manifest.ref,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      count: localized.length
    })}`,
    `Use file_read with ${JSON.stringify({ path: manifest.ref, offset: 1, limit: 400 })} to inspect every source.`,
    "",
    "Sources:",
    ...rendered
  ].join("\n")
}

const scriptResultRequest = (
  delivery: ScriptResultDelivery,
  content: string
): ChatRunnerSendMessageRequest => {
  const { payload } = delivery
  return {
    sessionId: payload.sessionId,
    clientId: workflowDeliveryClientId({
      workflowRef: payload.workflowRef,
      attempt: payload.attempt
    }),
    message: content,
    interaction: {
      kind: "completion",
      from: { type: "workflow", id: payload.workflowRef },
      to: { type: "agent", id: payload.sessionRef },
      content,
      ...(payload.preview === null ? {} : { preview: payload.preview }),
      outcome: payload.status === "succeeded" ? "completed" : payload.status,
      causedBy: { type: "workflow", id: `${payload.workflowRef}:${payload.attempt}` }
    },
    isMeta: true,
    workflowDelivery: {
      workflowRef: payload.workflowRef,
      attempt: payload.attempt
    }
  }
}

const localizedScriptResultRequest = async (
  delivery: ScriptResultDelivery,
  outputs: ManagedOutputWriter
): Promise<ChatRunnerSendMessageRequest> => {
  const sources = await localizedSourcesText(delivery, outputs)
  const localized = await outputs.localizeText({
    sessionId: delivery.payload.sessionId,
    text: `${delivery.body}${sources}`,
    source: {
      kind: "workflow",
      workflow_ref: delivery.payload.workflowRef,
      attempt: delivery.payload.attempt
    }
  })
  return scriptResultRequest(delivery, localized.content)
}

export interface ScriptResultDrainInput {
  readonly results: ScriptResults["Service"]
  readonly limit: number
  readonly send: (request: ChatRunnerSendMessageRequest) => Promise<unknown>
  readonly outputs: ManagedOutputWriter
}

const scriptResultOutbox = (
  input: ScriptResultDrainInput
): Outbox<ScriptResultDelivery, ScriptResultError, never> => ({
  name: "script_results",
  pending: input.results.pending(input.limit),
  deliver: Effect.fn("ScriptResultDelivery.deliver")(function* (delivery) {
    const identity = {
      workflowRef: delivery.payload.workflowRef,
      attempt: delivery.payload.attempt
    }
    const admitted = yield* input.results.admitted(delivery)
    if (!admitted) {
      const request = yield* Effect.tryPromise({
        try: () => localizedScriptResultRequest(delivery, input.outputs),
        catch: (cause) =>
          new ScriptDeliveryError({
            message: "Script result could not be localized",
            ...identity,
            cause
          })
      })
      yield* Effect.tryPromise({
        try: () => input.send(request),
        catch: (cause) =>
          new ScriptDeliveryError({
            message: "Script result could not be delivered to Chat",
            ...identity,
            cause
          })
      })
    }
    yield* input.results.markDelivered(delivery.deliveryId)
    return true
  }),
  defer: (delivery, cause) => {
    const error = Cause.squash(cause)
    const identity = {
      workflowRef: delivery.payload.workflowRef,
      attempt: delivery.payload.attempt
    }
    return input.results
      .defer({ deliveryId: delivery.deliveryId, error: errorMessage(error) })
      .pipe(
        Effect.flatMap((deferral) =>
          deferral.kind === "retrying"
            ? Effect.logWarning("Script result delivery failed; retrying later", {
                ...identity,
                attempts: deferral.attempts,
                nextAttemptAt: deferral.nextAttemptAt,
                error
              })
            : Effect.logError("Script result delivery failed too often; it will not be retried", {
                ...identity,
                attempts: deferral.attempts,
                error
              })
        ),
        Effect.catchCause((recordCause) =>
          Effect.logWarning(
            "Script result delivery failed and its retry state could not be recorded",
            { ...identity, error, recordError: Cause.squash(recordCause) }
          )
        )
      )
  }
})

export const drainScriptResults = (
  input: ScriptResultDrainInput
): Effect.Effect<number, ScriptResultError> => drainOutbox(scriptResultOutbox(input))

export const retryScriptResults = (input: ScriptResultDrainInput): Effect.Effect<never> =>
  runOutbox(scriptResultOutbox(input), pollEverySecond)
