import type {
  AdoptableWorkingChange,
  ManagedFileRepositoryShape,
  RevisionError,
  WorkingFileChange
} from "@arden-hq/revisions/effect"
import { compareCodePoints } from "@arden-hq/std/json"
import { Effect } from "effect"
import { posix } from "node:path"

import type { SpaceStore } from "../persistence/spaces/store.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "./authority.js"
import {
  encodeWikiOrigin,
  requireCommitRules,
  updatePage,
  type WikiCommitIdentity
} from "./commit.js"
import { mapRevisionError, type WikiError } from "./errors.js"
import type { Snapshot } from "./snapshot.js"
import { requireArchivable, requireUpdatable, type WikiWriter } from "./write-rules.js"

/**
 * What Memory does with one file that differs from its history, by the file's state and by
 * whether Arden's own rules would let the owner make that change in the app:
 *
 * | File                            | Rules allow it | Memory                                   |
 * | ------------------------------- | -------------- | ---------------------------------------- |
 * | changed, a valid page           | yes            | `take_in`: one update by `user:external` |
 * | missing                         | yes            | `take_in`: one archive                   |
 * | changed or missing              | no             | `set_aside`: recall keeps the last good  |
 * | unreadable                      | -              | `set_aside`                              |
 * | not in history, a `.md` file    | not yet        | `not_in_memory`: listed, never added     |
 */
export type OutsideEdit =
  | { readonly kind: "take_in"; readonly change: AdoptableWorkingChange }
  | {
      readonly kind: "set_aside"
      readonly pageId: string
      readonly path: string
      readonly reason: "unreadable" | "refused"
      readonly detail: string
    }
  | { readonly kind: "not_in_memory"; readonly path: string }

export type SetAside = Extract<OutsideEdit, { readonly kind: "set_aside" }>

export interface OutsideEditCheck {
  /** One commit each, oldest first. */
  readonly takenIn: ReadonlyArray<{
    readonly path: string
    readonly action: "update" | "archive"
    readonly revision: string
  }>
  readonly setAside: ReadonlyArray<SetAside>
  readonly notInMemory: ReadonlyArray<string>
  /** Changed again while it was being taken in; the next check takes it in. */
  readonly changedDuringCheck: ReadonlyArray<string>
  /** Untracked files that are not `.md`: Arden's rules make only `.md` files pages. */
  readonly otherFiles: ReadonlyArray<string>
}

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
    pages: Snapshot
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
          requireUpdatable(spaces, pages, record, { ...writer(record.page.pageId), content }).pipe(
            Effect.andThen(
              requireCommitRules([updatePage(record.resource, content)]).pipe(
                Effect.mapError(mapRevisionError("observe", record.page.pageId))
              )
            )
          )
        )
        return refused === undefined ? { kind: "take_in", change } : setAside("refused", refused)
      }
      case "missing": {
        const refused = yield* allowed(
          requireArchivable(spaces, pages, record, writer(record.page.pageId))
        )
        return refused === undefined ? { kind: "take_in", change } : setAside("refused", refused)
      }
    }
  })

  const scanAndTakeIn = Effect.fn("Wiki.scanAndTakeIn")(function* (): Effect.fn.Return<
    OutsideEditCheck,
    WikiError
  > {
    const status = yield* repository.workingTreeStatus.pipe(
      Effect.mapError(mapRevisionError("observe"))
    )
    const notInMemory = status.untracked.filter((path) => path.endsWith(".md"))
    const otherFiles = status.untracked.filter((path) => !path.endsWith(".md"))
    const takenIn: Array<OutsideEditCheck["takenIn"][number]> = []
    const setAside: Array<SetAside> = []
    const changedDuringCheck: Array<string> = []
    if (status.changes.length === 0)
      return { takenIn, setAside, notInMemory, changedDuringCheck, otherFiles }
    let pages = yield* input.snapshot()
    for (const change of [...status.changes].sort(byOrder)) {
      const decided = yield* decide(change, pages)
      if (decided.kind !== "take_in") {
        if (decided.kind === "set_aside") setAside.push(decided)
        continue
      }
      const adopted = yield* repository
        .adoptWorkingChange(decided.change, {
          actor: OUTSIDE_EDIT_IDENTITY.actor,
          origin: encodeWikiOrigin(OUTSIDE_EDIT_IDENTITY.origin),
          reason: OUTSIDE_EDIT_IDENTITY.reason
        })
        .pipe(Effect.result)
      if (adopted._tag === "Failure") {
        const outcome = adoptionFailure(adopted.failure)
        if (outcome === "fail")
          return yield* mapRevisionError("observe", change.resource.resourceId)(adopted.failure)
        if (outcome === "again") changedDuringCheck.push(change.resource.path)
        else
          setAside.push({
            kind: "set_aside",
            pageId: change.resource.resourceId,
            path: change.resource.path,
            reason: "refused",
            detail: adopted.failure.message
          })
        continue
      }
      takenIn.push({
        path: change.resource.path,
        action: change.kind === "missing" ? "archive" : "update",
        revision: adopted.success.commit.commitId
      })
      if (change.kind === "missing") pages = withoutPage(pages, change.resource.resourceId)
    }
    return { takenIn, setAside, notInMemory, changedDuringCheck, otherFiles }
  })

  let listed = "[[],[]]"
  /** Takes in what the rules allow; logs the files left out each time that list changes. */
  const check = Effect.fn("Wiki.checkOutsideEdits")(function* () {
    const result = yield* scanAndTakeIn()
    const leftOut = JSON.stringify([
      result.setAside.map((item) => [item.path, item.detail]),
      result.notInMemory
    ])
    if (leftOut !== listed) {
      listed = leftOut
      yield* Effect.logWarning("Memory files changed outside Arden and left out", {
        setAside: result.setAside.map((item) => `${item.path}: ${item.detail}`),
        notInMemory: result.notInMemory
      })
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

/** An archive taken in leaves the pages the next decision in this check sees. */
const withoutPage = (snapshot: Snapshot, pageId: string): Snapshot => ({
  head: snapshot.head,
  pages: snapshot.pages.filter((record) => record.page.pageId !== pageId)
})

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
