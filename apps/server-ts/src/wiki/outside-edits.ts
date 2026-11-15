import type {
  AdoptableWorkingChange,
  ManagedFileRepositoryShape,
  RevisionError,
  UntrackedFile,
  WorkingFileChange
} from "@arden-hq/revisions/effect"
import { sha256Hex } from "@arden-hq/std/hash"
import { compareCodePoints } from "@arden-hq/std/json"
import { Effect, Option } from "effect"
import { posix } from "node:path"

import type { SpaceStore } from "../persistence/spaces/store.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "./authority.js"
import { commitOutsideChange, type WikiCommitIdentity } from "./commit.js"
import { mapRevisionError, type WikiError } from "./errors.js"
import { parseWikiPage } from "./page.js"
import type { Snapshot } from "./snapshot.js"
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

export interface OutsideEditCheck {
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
  readonly notInMemory: ReadonlyArray<string>
  /** Untracked files that are not `.md`: Arden's rules make only `.md` files pages. */
  readonly otherFiles: ReadonlyArray<string>
  /** Untracked files or folders that could not be read, with the reason. */
  readonly unreadableFiles: ReadonlyArray<{ readonly path: string; readonly reason: string }>
}

/**
 * More pages missing at once than this is read as a folder moved, renamed or not mounted, not as
 * a decision to forget them: none is archived, and each is set aside with a notice. Archiving
 * that many pages is left to the app, where it is one deliberate act.
 */
export const MAX_MISSING_ARCHIVED = 20

const OUTSIDE_EDIT_IDENTITY = {
  actor: "user:external",
  origin: { kind: "user", via: "filesystem" },
  reason: "take in a change made outside Arden"
} as const satisfies WikiCommitIdentity

const writer = (pageId: string): WikiWriter => ({
  pageId,
  authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
  commit: OUTSIDE_EDIT_IDENTITY
})

/** Rule refusals set a page aside; a failing store or repository fails the whole check. */
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

const decoder = new TextDecoder("utf-8", { fatal: true })

const utf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

const isPagePath = (path: string): boolean => path.endsWith(".md")

/** The state a change was seen in, so two checks can tell whether it stayed the same. */
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

/** Updates first, then archives deepest first with each folder's README after its pages, so
 *  a folder deleted outside is archived in one check. */
const rank = (change: WorkingFileChange): number => {
  if (change.kind !== "missing") return 0
  return posix.basename(change.resource.path).toLowerCase() === "readme.md" ? 2 : 1
}

const depth = (change: WorkingFileChange): number => change.resource.path.split("/").length

const byOrder = (left: WorkingFileChange, right: WorkingFileChange): number =>
  rank(left) - rank(right) ||
  depth(right) - depth(left) ||
  compareCodePoints(left.resource.path, right.resource.path)

/** Where each untracked page file now stands, by the page id in its front matter and by its
 *  exact bytes, so a page moved outside is recognized rather than archived. */
const untrackedPages = Effect.fn("Wiki.untrackedPages")(function* (
  files: ReadonlyArray<UntrackedFile>
) {
  const byPageId = new Map<string, string>()
  const byBlob = new Map<string, string>()
  for (const file of files) {
    if (file.kind !== "read") continue
    byBlob.set(sha256Hex(file.content), file.path)
    const text = utf8(file.content)
    if (text === undefined) continue
    const parsed = yield* Effect.option(parseWikiPage(text))
    if (Option.isSome(parsed)) byPageId.set(parsed.value.pageId, file.path)
  }
  return { byPageId, byBlob }
})

/**
 * The one place that reads the working tree against Memory history and takes changes in. It runs
 * from the Memory change poll, never from a chat turn: recall reads history only, so a broken
 * file outside never stops it.
 */
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
    const record = pages.pages.find((page) => page.page.pageId === resource.resourceId)
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

  /** Each page's state at the check before, by page id. */
  let seenBefore = new Map<string, string>()

  const scanAndTakeIn = Effect.fn("Wiki.scanAndTakeIn")(function* (): Effect.fn.Return<
    OutsideEditCheck,
    WikiError
  > {
    const status = yield* repository
      .workingTreeStatus({ readUntracked: isPagePath })
      .pipe(Effect.mapError(mapRevisionError("observe")))
    const before = seenBefore
    seenBefore = new Map(
      status.changes.map((change) => [change.resource.resourceId, stateOf(change)])
    )
    const readable = status.untracked.filter((file) => file.kind !== "unreadable")
    const notInMemory = readable.map((file) => file.path).filter(isPagePath)
    const otherFiles = readable.map((file) => file.path).filter((path) => !isPagePath(path))
    const unreadableFiles = status.untracked.flatMap((file) =>
      file.kind === "unreadable" ? [{ path: file.path, reason: file.reason }] : []
    )
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
    for (const change of [...status.changes].sort(byOrder)) {
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
        repository,
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
  /** Takes in what the rules allow; logs the files left out each time that list changes. */
  const check = Effect.fn("Wiki.checkOutsideEdits")(function* () {
    const result = yield* scanAndTakeIn()
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

  /** The rule refusal's message, or undefined when the rules allow the change. */
  const allowed = (rules: Effect.Effect<unknown, WikiError>) =>
    rules.pipe(
      Effect.as(undefined),
      Effect.catch((cause) => {
        const refused = refusal(cause)
        return refused === undefined ? Effect.fail(cause) : Effect.succeed(refused)
      })
    )

  return { check }
}

const adoptionFailure = (cause: RevisionError): "again" | "refused" | "fail" => {
  switch (cause._tag) {
    case "RevisionConflictError":
      return "again"
    case "InvalidRevisionInputError":
    case "NoChangesError":
    case "RevisionContentLimitError":
    case "UnsafePathError":
      return "refused"
    case "CorruptRepositoryError":
    case "IdempotencyConflictError":
    case "RepositoryClosedError":
    case "RevisionStorageError":
      return "fail"
  }
}
