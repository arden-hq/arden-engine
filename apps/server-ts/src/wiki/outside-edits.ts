import {
  type AdoptableWorkingChange,
  type ManagedFileRepositoryShape,
  type UntrackedFile,
  type WorkingFileChange,
  WorkingFileChangedError
} from "@arden-hq/revisions/effect"
import { sha256Hex } from "@arden-hq/std/hash"
import { compareCodePoints } from "@arden-hq/std/json"
import { Effect } from "effect"

import type { SpaceStore } from "../persistence/spaces/store.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "./authority.js"
import { commitOutsideChange, type WikiCommitError, type WikiCommitIdentity } from "./commit.js"
import { mapRevisionError, WikiError } from "./errors.js"
import { isReadme } from "./page.js"
import type { Snapshot } from "./snapshot.js"
import {
  UNTRACKED_PAGES,
  untrackedFiles,
  untrackedPageIds,
  utf8,
  type UntrackedFiles
} from "./untracked.js"
import { requireArchivable, requireUpdatable, type WikiWriter } from "./write-rules.js"

/**
 * What Memory does with one file that differs from its history. Nothing is decided about a file
 * until a check finds it in the same state as the check before, one poll apart.
 *
 * | File                                  | Rules allow it | Memory                                   |
 * | ------------------------------------- | -------------- | ---------------------------------------- |
 * | differs from the check before         | -              | `settling`: decided at the next check    |
 * | changed, a valid page                 | yes            | `take_in`: one update by `user:external` |
 * | missing                               | yes            | `take_in`: one archive                   |
 * | missing, its page found at a new path | -              | `set_aside`, `moved`                     |
 * | missing, with too many others         | -              | `set_aside`, `many_missing`              |
 * | changed or missing                    | no             | `set_aside`: recall keeps the last good  |
 * | unreadable                            | -              | `set_aside`                              |
 * | not in history, a `.md` file          | not yet        | `notInMemory`: listed, never added       |
 */
export type OutsideEdit =
  | { readonly kind: "take_in"; readonly change: AdoptableWorkingChange }
  | {
      readonly kind: "set_aside"
      readonly pageId: string
      readonly path: string
      readonly reason: "unreadable" | "refused" | "moved" | "many_missing"
      readonly detail: string
    }

export type SetAside = Extract<OutsideEdit, { readonly kind: "set_aside" }>

/**
 * Where a page whose file differs from its history stands, as of the last check: `set_aside`
 * until the file is fixed or put back, or `settling` until the next check decides it. Every write
 * to such a page is refused until the check takes the change in.
 */
export type OutsideEditState =
  | { readonly kind: "set_aside"; readonly path: string; readonly detail: string }
  | { readonly kind: "settling"; readonly path: string }

export interface OutsideEditCheck extends UntrackedFiles {
  /** One commit each, oldest first. */
  readonly takenIn: ReadonlyArray<{
    readonly path: string
    readonly action: "update" | "archive"
    readonly revision: string
  }>
  readonly setAside: ReadonlyArray<SetAside>
  /** Not in the same state as at the check before; decided at the next check if it stays. */
  readonly settling: ReadonlyArray<string>
  /** Changed again, or Memory changed, while it was being taken in; the next check decides. */
  readonly changedDuringCheck: ReadonlyArray<string>
}

export const MAX_MISSING_ARCHIVED = 20

const OUTSIDE_EDIT_IDENTITY = {
  actor: "user:external",
  origin: { kind: "user", via: "filesystem" },
  reason: "take in a change made outside Arden"
} as const satisfies WikiCommitIdentity

const writer = (pageId: string): WikiWriter => ({
  pageId,
  authority: GLOBAL_WIKI_LOCATION_AUTHORITY
})

const refusal = (cause: WikiError): string | undefined => {
  switch (cause.reason) {
    case "invalid":
    case "blocked":
    case "not_found":
    case "conflict":
      return cause.message
    case "closed":
    case "corrupt":
    case "storage":
      return undefined
  }
}

const stateOf = (change: WorkingFileChange): string => {
  switch (change.kind) {
    case "changed":
      return `changed:${sha256Hex(change.content)}`
    case "missing":
      return "missing"
    case "unreadable":
      return `unreadable:${change.reason}`
  }
}

const STAGES = ["update", "archive", "archive_readme"] as const

const stage = (change: WorkingFileChange): (typeof STAGES)[number] => {
  if (change.kind !== "missing") return "update"
  return isReadme(change.resource.path) ? "archive_readme" : "archive"
}

const depth = (change: WorkingFileChange): number => change.resource.path.split("/").length

const updatesThenDeepestArchivesReadmeLast = (
  left: WorkingFileChange,
  right: WorkingFileChange
): number =>
  STAGES.indexOf(stage(left)) - STAGES.indexOf(stage(right)) ||
  depth(right) - depth(left) ||
  compareCodePoints(left.resource.path, right.resource.path)

const untrackedPages = Effect.fn("Wiki.untrackedPages")(function* (
  files: ReadonlyArray<UntrackedFile>
) {
  const byPageId = new Map(
    (yield* untrackedPageIds(files)).map(({ pageId, path }) => [pageId, path] as const)
  )
  const byBlob = new Map(
    files.flatMap((file) =>
      file.kind === "read" ? [[sha256Hex(file.content), file.path] as const] : []
    )
  )
  return { byPageId, byBlob }
})

export const makeOutsideEdits = (input: {
  readonly repository: ManagedFileRepositoryShape
  readonly spaces: SpaceStore["Service"]
  readonly snapshot: () => Effect.Effect<Snapshot, WikiError>
}) => {
  const { repository, spaces } = input

  const decide = Effect.fn("Wiki.decideOutsideEdit")(function* (
    change: WorkingFileChange,
    pages: Snapshot,
    found: {
      readonly movedTo: (pageId: string, blobId: string) => string | undefined
      readonly manyMissing: number | undefined
    }
  ): Effect.fn.Return<OutsideEdit, WikiError> {
    const resource = change.resource
    const setAside = (reason: SetAside["reason"], detail: string): SetAside => ({
      kind: "set_aside",
      pageId: resource.resourceId,
      path: resource.path,
      reason,
      detail
    })
    const record = pages.wholeSet.find((page) => page.page.pageId === resource.resourceId)
    if (record === undefined) return setAside("refused", "The file is not a Memory page")
    switch (change.kind) {
      case "unreadable":
        return setAside("unreadable", change.reason)
      case "changed": {
        const content = utf8(change.content)
        if (content === undefined) return setAside("unreadable", "The file is not UTF-8 text")
        const refused = yield* allowed(
          requireUpdatable(spaces, pages, record, { ...writer(record.page.pageId), content })
        )
        return refused === undefined ? { kind: "take_in", change } : setAside("refused", refused)
      }
      case "missing": {
        const movedTo = found.movedTo(resource.resourceId, resource.blobId)
        if (movedTo !== undefined)
          return setAside(
            "moved",
            `The page is now at ${movedTo}; Arden does not take in a page moved outside`
          )
        if (found.manyMissing !== undefined)
          return setAside(
            "many_missing",
            `${found.manyMissing} pages are missing at once, more than the ${MAX_MISSING_ARCHIVED} one check archives; archive them in the app if that was meant`
          )
        const refused = yield* allowed(
          requireArchivable(spaces, pages, record, writer(record.page.pageId))
        )
        return refused === undefined ? { kind: "take_in", change } : setAside("refused", refused)
      }
    }
  })

  let seenBefore = new Map<string, string>()
  let leftOutByPath = new Map<string, OutsideEditState>()

  const scanAndTakeIn = Effect.fn("Wiki.scanAndTakeIn")(function* (): Effect.fn.Return<
    OutsideEditCheck,
    WikiError
  > {
    const status = yield* repository
      .workingTreeStatus(UNTRACKED_PAGES)
      .pipe(Effect.mapError(mapRevisionError("observe")))
    const before = seenBefore
    seenBefore = new Map(
      status.changes.map((change) => [change.resource.resourceId, stateOf(change)])
    )
    const { notInMemory, otherFiles, unreadableFiles } = untrackedFiles(status.untracked)
    const takenIn: Array<OutsideEditCheck["takenIn"][number]> = []
    const setAside: Array<SetAside> = []
    const settling: Array<string> = []
    const changedDuringCheck: Array<string> = []
    const result = () => ({
      takenIn,
      setAside,
      settling,
      changedDuringCheck,
      notInMemory,
      otherFiles,
      unreadableFiles
    })
    if (status.changes.length === 0) return result()
    const untracked = yield* untrackedPages(status.untracked)
    const missing = status.changes.filter((change) => change.kind === "missing").length
    const found = {
      movedTo: (pageId: string, blobId: string) =>
        untracked.byPageId.get(pageId) ?? untracked.byBlob.get(blobId),
      manyMissing: missing > MAX_MISSING_ARCHIVED ? missing : undefined
    }
    let pages = yield* input.snapshot()
    for (const change of [...status.changes].sort(updatesThenDeepestArchivesReadmeLast)) {
      if (before.get(change.resource.resourceId) !== stateOf(change)) {
        settling.push(change.resource.path)
        continue
      }
      const decided = yield* decide(change, pages, found)
      if (decided.kind === "set_aside") {
        setAside.push(decided)
        continue
      }
      const adopted = yield* commitOutsideChange(
        { repository, spaces },
        { ...OUTSIDE_EDIT_IDENTITY, expectedRevision: pages.head },
        decided.change
      ).pipe(Effect.result)
      if (adopted._tag === "Failure") {
        const outcome = adoptionFailure(adopted.failure)
        if (outcome === "fail")
          return yield* mapRevisionError("observe", change.resource.resourceId)(adopted.failure)
        if (outcome === "refused") {
          setAside.push({
            kind: "set_aside",
            pageId: change.resource.resourceId,
            path: change.resource.path,
            reason: "refused",
            detail: adopted.failure.message
          })
          continue
        }
        changedDuringCheck.push(change.resource.path)
      } else {
        takenIn.push({
          path: change.resource.path,
          action: change.kind === "missing" ? "archive" : "update",
          revision: adopted.success.commit.commitId
        })
      }
      pages = yield* input.snapshot()
    }
    return result()
  })

  let listed = ""
  const check = Effect.fn("Wiki.checkOutsideEdits")(function* () {
    const result = yield* scanAndTakeIn()
    leftOutByPath = new Map<string, OutsideEditState>([
      ...[...result.settling, ...result.changedDuringCheck].map(
        (path) => [path, { kind: "settling", path }] as const
      ),
      ...result.setAside.map(
        (item) => [item.path, { kind: "set_aside", path: item.path, detail: item.detail }] as const
      )
    ])
    const leftOut = {
      setAside: result.setAside.map((item) => `${item.path}: ${item.detail}`),
      notInMemory: result.notInMemory,
      unreadableFiles: result.unreadableFiles.map((item) => `${item.path}: ${item.reason}`)
    }
    const key = JSON.stringify(leftOut)
    if (key !== listed) {
      const first = listed === ""
      listed = key
      const empty =
        leftOut.setAside.length + leftOut.notInMemory.length + leftOut.unreadableFiles.length === 0
      if (!(first && empty))
        yield* Effect.logWarning("Memory files changed outside Arden and left out", leftOut)
    }
    return result
  })

  const allowed = (rules: Effect.Effect<unknown, WikiError>) =>
    rules.pipe(
      Effect.as(undefined),
      Effect.catch((cause) => {
        const refused = refusal(cause)
        return refused === undefined ? Effect.fail(cause) : Effect.succeed(refused)
      })
    )

  const state = (path: string): OutsideEditState | undefined => leftOutByPath.get(path)

  const explain = (error: WikiError): WikiError => {
    const cause = error.cause
    if (!(cause instanceof WorkingFileChangedError)) return error
    return new WikiError({ ...error, message: outsideEditRefusal(cause.path, state(cause.path)) })
  }

  return { check, state, explain }
}

const outsideEditRefusal = (path: string, state: OutsideEditState | undefined): string =>
  state?.kind === "set_aside"
    ? `${path} was changed outside Arden and Memory set that change aside: ${state.detail}. Nothing was saved. Arden cannot write this page until its file is fixed or put back.`
    : `${path} was changed outside Arden and Memory has not taken that change in yet. Nothing was saved. Memory checks the files every minute and takes a change in once it stays the same for one check.`

const adoptionFailure = (cause: WikiCommitError): "again" | "refused" | "fail" => {
  switch (cause._tag) {
    case "RevisionConflictError":
    case "WorkingFileChangedError":
      return "again"
    case "WikiCommitRuleError":
    case "InvalidRevisionInputError":
    case "NoChangesError":
    case "RevisionContentLimitError":
    case "UnsafePathError":
      return "refused"
    case "CorruptRepositoryError":
    case "IdempotencyConflictError":
    case "RepositoryClosedError":
    case "RevisionStorageError":
    case "SpaceStoreError":
      return "fail"
  }
}

/** What a read of such a page says about it. */
export const outsideEditNotice = (state: OutsideEditState): string =>
  state.kind === "set_aside"
    ? `This page's file was changed outside Arden and Memory set that change aside: ${state.detail}. This version stays in Memory, and writes to the page are refused until the file is fixed or put back.`
    : "This page's file was changed outside Arden; Memory takes the change in at its next check, and writes to the page are refused until then."
