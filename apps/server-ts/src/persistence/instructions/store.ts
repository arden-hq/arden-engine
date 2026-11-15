import { Context, type Effect, Schema } from "effect"

import { storeErrorFields } from "../errors.js"

/** The chat turn that changed the rules. */
export interface InstructionChat {
  readonly sessionId: string
  readonly runId: string
}

/**
 * Who made one version of the standing rules. `seed`: the rules as they were when the history
 * began. `outside`: the file changed outside Arden, taken as the owner's own edit. `chat` and
 * `restore`: the owner's own chat turn, after their approval; `restore` brought back an earlier
 * version. `chat` is undefined once that chat was deleted.
 */
export type InstructionWriter =
  | { readonly kind: "seed" }
  | { readonly kind: "outside" }
  | { readonly kind: "chat"; readonly chat: InstructionChat | undefined }
  | { readonly kind: "restore"; readonly chat: InstructionChat | undefined; readonly from: number }

export interface InstructionVersion {
  readonly version: number
  /** The rules text; empty when there were none. */
  readonly content: string
  /** The file's version as `GlobalInstructions` reads it. */
  readonly digest: string
  readonly writer: InstructionWriter
  readonly recordedAt: string
}

export class InstructionVersionStoreError extends Schema.TaggedError<InstructionVersionStoreError>()(
  "InstructionVersionStoreError",
  { ...storeErrorFields({ operations: ["read", "append"], reasons: ["corrupt", "storage"] }) }
) {}

/** The standing rules' versions, numbered from 1; a number is never reused. */
export class InstructionVersionStore extends Context.Service<
  InstructionVersionStore,
  {
    readonly latest: () => Effect.Effect<
      InstructionVersion | undefined,
      InstructionVersionStoreError
    >
    readonly get: (
      version: number
    ) => Effect.Effect<InstructionVersion | undefined, InstructionVersionStoreError>
    /** Newest first, with how many versions are kept. */
    readonly list: (input: {
      readonly limit: number
    }) => Effect.Effect<
      { readonly versions: ReadonlyArray<InstructionVersion>; readonly total: number },
      InstructionVersionStoreError
    >
    readonly append: (input: {
      readonly content: string
      readonly digest: string
      readonly writer: InstructionWriter
    }) => Effect.Effect<InstructionVersion, InstructionVersionStoreError>
  }
>()("@arden-hq/server/persistence/instructions/InstructionVersionStore") {}
