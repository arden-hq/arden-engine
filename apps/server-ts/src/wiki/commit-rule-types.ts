import type {
  ManagedFileRepositoryShape,
  ResourceVersion,
  RevisionError
} from "@arden-hq/revisions/effect"
import { Effect, Option } from "effect"

import type { SpaceStoreError } from "../persistence/spaces/store.js"
import type { WikiWriteBoundary } from "./authority.js"
import type { RecordFolders } from "./collections.js"
import { WikiCommitRuleError, type WikiPageAction } from "./commit-write-types.js"
import type { WikiError } from "./errors.js"
import type { WikiCommitOrigin } from "./origin.js"
import type { ParsedWikiPage } from "./page.js"
import type { OpenRetraction } from "./retraction.js"
import type { Snapshot } from "./snapshot.js"

export interface ResolvedWrite {
  readonly action: WikiPageAction
  readonly resourceId: string
  readonly before: ResourceVersion | null
  readonly path: { readonly before: string | undefined; readonly after: string | undefined }
  readonly given: Uint8Array | undefined
  readonly page: Option.Option<ParsedWikiPage>
  readonly beforeContent: Effect.Effect<Uint8Array | null, RevisionError>
  readonly pageBefore: Effect.Effect<Option.Option<ParsedWikiPage>, RevisionError>
}

export interface CommitView {
  readonly repository: ManagedFileRepositoryShape
  readonly origin: WikiCommitOrigin
  readonly folders: Effect.Effect<RecordFolders, RevisionError>
  readonly occupied: Effect.Effect<ReadonlyMap<string, string>, RevisionError>
  readonly guarded: Effect.Effect<ReadonlyMap<string, OpenRetraction>, RevisionError>
  readonly spaceOwns: (pageId: string, path: string) => Effect.Effect<boolean, SpaceStoreError>
  readonly snapshot: Effect.Effect<Snapshot, WikiError>
  readonly boundary: Effect.Effect<WikiWriteBoundary | undefined, WikiError>
}

export const ruleError = (
  rule: WikiCommitRuleError["rule"],
  message: string
): WikiCommitRuleError => new WikiCommitRuleError({ rule, message })
