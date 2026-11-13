import { Context } from "effect"

import type { ManagedObjectDescriptor } from "./descriptor.js"
import type { ManagedOutputLifecycleStore } from "./lifecycle-store.js"
import { makeManagedObjectStore } from "./object-store.js"

/**
 * Where a large tool result is kept whole: a managed object owned by the
 * result's chat, so deleting the chat removes it with the chat's other files.
 */
export interface ToolResultObjectStore {
  readonly publish: (input: {
    readonly sessionId: string
    readonly toolName: string
    readonly toolCallId: string
    readonly text: string
  }) => Promise<ManagedObjectDescriptor>
  readonly read: (ref: string) => Promise<string>
}

/** `undefined` when storage has no managed-output folder (an in-memory test database). */
export const ToolResultObjects = Context.Reference<ToolResultObjectStore | undefined>(
  "@arden-hq/server/persistence/managed-output/ToolResultObjects",
  { defaultValue: () => undefined }
)

export const makeToolResultObjects = (
  root: string,
  lifecycle: Pick<ManagedOutputLifecycleStore["Service"], "withLiveSession">
): ToolResultObjectStore => {
  const objects = makeManagedObjectStore(root)
  return {
    publish: (input) =>
      lifecycle.withLiveSession(input.sessionId, () =>
        objects.publish({
          sessionId: input.sessionId,
          text: input.text,
          format: "json",
          source: { kind: "tool", name: input.toolName, call_id: input.toolCallId }
        })
      ),
    read: objects.readRef
  }
}
