import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import type { RecordedHistoryInput, RecordedHistoryPage, RecordedHistoryError } from "../history.js"
import { storeErrorFields } from "../errors.js"
import type {
  CreateSpaceInput,
  Space,
  SpaceArchiveResponse,
  SpaceDetail,
  SpacesOverview,
  UpdateSpaceInput
} from "@arden-hq/protocol/spaces"
import { Context, Effect, Schema } from "effect"

export type PersistedSpace = Space & { readonly page_id: string | null }

export const spaceChoices = (
  spaces: ReadonlyArray<{ readonly space_id: string; readonly name: string }>
): string =>
  spaces.length === 0
    ? "There is no active Space."
    : `Pass space_id, one of: ${spaces.map((space) => `${space.name} (${space.space_id})`).join(", ")}.`

export const KEEP_ONE_SPACE = "Keep at least one Space"

export const isKeepOneSpace = (error: {
  readonly reason: string
  readonly message: string
}): boolean => error.reason === "conflict" && error.message === KEEP_ONE_SPACE

export class SpaceStoreError extends Schema.TaggedError<SpaceStoreError>()("SpaceStoreError", {
  ...storeErrorFields({
    operations: [
      "list",
      "create",
      "get",
      "update",
      "archive",
      "restore",
      "page",
      "detail",
      "overview",
      "page_binding"
    ],
    reasons: ["invalid", "conflict", "storage"]
  }),
  spaceId: Schema.optionalKey(Schema.NonEmptyString)
}) {}

export class SpaceStore extends Context.Service<
  SpaceStore,
  {
    readonly history: (
      input: RecordedHistoryInput
    ) => Effect.Effect<RecordedHistoryPage, RecordedHistoryError>
    readonly list: () => Effect.Effect<ReadonlyArray<PersistedSpace>, SpaceStoreError>
    readonly listArchived: () => Effect.Effect<ReadonlyArray<PersistedSpace>, SpaceStoreError>
    readonly create: (
      input: CreateSpaceInput,
      mutation?: MutationOperationIdentity
    ) => Effect.Effect<PersistedSpace, SpaceStoreError>
    readonly get: (
      spaceId: string,
      includeArchived?: boolean
    ) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly update: (
      spaceId: string,
      input: UpdateSpaceInput,
      runId?: string,
      toolCallId?: string
    ) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly setGeneratedInstructions: (
      spaceId: string,
      instructions: string
    ) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly bindPage: (
      spaceId: string,
      pageId: string,
      pagePath: string
    ) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly detachPage: (spaceId: string) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly archive: (
      spaceId: string,
      mutation?: MutationOperationIdentity
    ) => Effect.Effect<SpaceArchiveResponse | null, SpaceStoreError>
    readonly restore: (spaceId: string) => Effect.Effect<PersistedSpace | null, SpaceStoreError>
    readonly detail: (spaceId: string) => Effect.Effect<SpaceDetail | null, SpaceStoreError>
    readonly recordLetterSubject: (
      sessionId: string,
      messageId: string,
      subject: string
    ) => Effect.Effect<void, SpaceStoreError>
    readonly linkChat: (
      spaceId: string,
      sessionId: string,
      throughSequence: number
    ) => Effect.Effect<boolean, SpaceStoreError>
    readonly unlinkedSpaces: (
      sessionId: string,
      throughSequence: number,
      spaceIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<string>, SpaceStoreError>
    readonly overview: () => Effect.Effect<SpacesOverview, SpaceStoreError>
    readonly setPinned: (spaceIds: ReadonlyArray<string>) => Effect.Effect<void, SpaceStoreError>
    readonly hasPageBinding: (
      pageId: string,
      path: string
    ) => Effect.Effect<boolean, SpaceStoreError>
    readonly ownsWikiPath: (path: string) => Effect.Effect<boolean, SpaceStoreError>
  }
>()("@arden-hq/server/persistence/spaces/SpaceStore") {}
