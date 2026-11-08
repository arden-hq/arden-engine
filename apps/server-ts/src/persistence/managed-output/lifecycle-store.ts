import { Context } from "effect"

export type UploadDecision = "kept" | "remove" | "wait" | "gone"

export class ManagedOutputLifecycleStore extends Context.Service<
  ManagedOutputLifecycleStore,
  {
    readonly withLiveSession: <A>(sessionId: string, action: () => Promise<A>) => Promise<A>
    readonly pendingCleanup: () => Promise<ReadonlyArray<string>>
    readonly cleanupSession: (input: {
      readonly sessionId: string
      readonly ownerDigests: () => Promise<ReadonlyArray<string>>
      readonly remove: () => Promise<void>
    }) => Promise<boolean>
    readonly drain: () => Promise<void>
    readonly forgetOutput: (input: {
      readonly sessionId: string
      readonly digest: string
      readonly remove: () => Promise<boolean>
    }) => Promise<boolean>
    readonly pendingGc: () => Promise<
      ReadonlyArray<{ readonly sessionId: string; readonly digest: string }>
    >
    readonly completeGc: (
      sessionId: string,
      digest: string,
      action: () => Promise<void>
    ) => Promise<boolean>
    readonly pendingUploads: () => Promise<ReadonlyArray<string>>
    readonly queueUploads: (uploadIds: ReadonlyArray<string>) => Promise<void>
    readonly decideUpload: (uploadId: string) => Promise<UploadDecision>
    readonly finishUpload: (uploadId: string) => Promise<void>
    readonly deferUpload: (uploadId: string) => Promise<boolean>
  }
>()("@arden-hq/server/persistence/managed-output/ManagedOutputLifecycleStore") {}
