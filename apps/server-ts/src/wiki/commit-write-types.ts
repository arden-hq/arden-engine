import type {
  CommitInput,
  ManagedFileRepositoryShape,
  ResourceVersion,
  RevisionError
} from "@arden-hq/revisions/effect"
import { Schema } from "effect"

import type { SpaceStore, SpaceStoreError } from "../persistence/spaces/store.js"
import { type WikiLocationAuthority } from "./authority.js"
import { type WikiError } from "./errors.js"
import { type WikiCommitOrigin } from "./origin.js"

export interface WikiWriter {
  readonly origin: WikiCommitOrigin
  readonly authority: WikiLocationAuthority
}

type WikiPageOperation = CommitInput["operations"][number]

export const WIKI_OPERATION = { Create: "Create", Archive: "Archive" } as const satisfies Record<
  string,
  WikiPageOperation["_tag"]
>

export type Operation<Tag extends WikiPageOperation["_tag"]> = Extract<
  WikiPageOperation,
  { readonly _tag: Tag }
>

export const WIKI_PAGE_ACTION = {
  create: "create",
  newPage: "new_page",
  publish: "publish",
  edit: "edit",
  restoreVersion: "restore_version",
  merge: "merge",
  move: "move",
  archive: "archive",
  restoreArchived: "restore_archived"
} as const

export type WikiWrite =
  | {
      readonly action: typeof WIKI_PAGE_ACTION.create | typeof WIKI_PAGE_ACTION.newPage
      readonly operation: Operation<"Create">
    }
  | {
      readonly action: typeof WIKI_PAGE_ACTION.publish
      readonly operation: Operation<"Create" | "Update">
    }
  | {
      readonly action:
        | typeof WIKI_PAGE_ACTION.edit
        | typeof WIKI_PAGE_ACTION.restoreVersion
        | typeof WIKI_PAGE_ACTION.merge
      readonly operation: Operation<"Update">
    }
  | { readonly action: typeof WIKI_PAGE_ACTION.move; readonly operation: Operation<"Move"> }
  | { readonly action: typeof WIKI_PAGE_ACTION.archive; readonly operation: Operation<"Archive"> }
  | {
      readonly action: typeof WIKI_PAGE_ACTION.restoreArchived
      readonly operation: Operation<"Restore">
    }

export type WikiPageAction = WikiWrite["action"]

export type PageVersion = Pick<ResourceVersion, "resourceId" | "versionId">

export const encoder = new TextEncoder()
export const decoder = new TextDecoder()

export const created = (
  resourceId: string,
  path: string,
  content: string
): Operation<typeof WIKI_OPERATION.Create> => ({
  _tag: "Create",
  resourceId,
  path,
  content: encoder.encode(content)
})

export const updated = (page: PageVersion, content: string): Operation<"Update"> => ({
  _tag: "Update",
  resourceId: page.resourceId,
  expectedVersion: page.versionId,
  content: encoder.encode(content)
})

export class WikiCommitRuleError extends Schema.TaggedError<WikiCommitRuleError>()(
  "WikiCommitRuleError",
  {
    rule: Schema.Literals([
      "aliases",
      "size",
      "records",
      "retire",
      "code_owned",
      "retraction",
      "space",
      "names"
    ] as const),
    message: Schema.String
  }
) {}

export type WikiCommitError = RevisionError | SpaceStoreError | WikiCommitRuleError | WikiError

export interface WikiCommitPoint {
  readonly repository: ManagedFileRepositoryShape
  readonly spaces: Pick<SpaceStore["Service"], "activeBindings" | "get">
}
