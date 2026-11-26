import {
  type AdoptableWorkingChange,
  UNTRACKED_FILE_KIND,
  WORKING_FILE_CHANGE_KIND,
  type ManagedFileRepositoryShape,
  type UntrackedFile,
  type WorkingFileChange,
  WorkingFileChangedError
} from "@arden-hq/revisions/effect"
import { sha256Hex } from "@arden-hq/std/hash"
import { compareCodePoints } from "@arden-hq/std/json"
import { Effect, Match, Result } from "effect"

import type { SpaceStore } from "../persistence/spaces/store.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "./authority.js"
import { commitOutsideChange } from "./commit.js"
import { type WikiCommitError, type WikiWriter } from "./commit-write-types.js"
import { type WikiCommitIdentity } from "./origin.js"
import { mapRevisionError, WIKI_ERROR_REASON, WikiError } from "./errors.js"
import { codeOwnedPage } from "./code-owned-pages.js"
import { isReadme, replacementContent } from "./page.js"
import type { Snapshot } from "./snapshot.js"
import {
  UNTRACKED_PAGES,
  untrackedFiles,
  untrackedPageIds,
  utf8,
  type UntrackedFiles
} from "./untracked.js"

const OUTSIDE_EDIT = { takeIn: "take_in", setAside: "set_aside" } as const

const SET_ASIDE_REASON = {
  unreadable: "unreadable",
  refused: "refused",
  moved: "moved",
  manyMissing: "many_missing"
} as const

const OUTSIDE_EDIT_STATE = { setAside: "set_aside", settling: "settling" } as const

const ADOPTION = { again: "again", refused: "refused", fail: "fail" } as const

type OutsideEdit =
  | { readonly kind: typeof OUTSIDE_EDIT.takeIn; readonly change: AdoptableWorkingChange }
  | {
      readonly kind: typeof OUTSIDE_EDIT.setAside
      readonly pageId: string
      readonly path: string
      readonly reason: (typeof SET_ASIDE_REASON)[keyof typeof SET_ASIDE_REASON]
      readonly detail: string
    }

type SetAside = Extract<OutsideEdit, { readonly kind: "set_aside" }>

export type OutsideEditState =
  | {
      readonly kind: typeof OUTSIDE_EDIT_STATE.setAside
      readonly path: string
      readonly detail: string
    }
  | { readonly kind: typeof OUTSIDE_EDIT_STATE.settling; readonly path: string }

export interface OutsideEditCheck extends UntrackedFiles {
  readonly takenIn: ReadonlyArray<{
    readonly path: string
    readonly action: "update" | "archive"
    readonly revision: string
  }>
  readonly setAside: ReadonlyArray<SetAside>
  readonly settling: ReadonlyArray<string>
  readonly changedDuringCheck: ReadonlyArray<string>
}

export const MAX_MISSING_ARCHIVED = 20

const OUTSIDE_EDIT_IDENTITY = {
  actor: "user:external",
  origin: { kind: "user", via: "filesystem" },
  authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
  reason: "take in a change made outside Arden"
} as const satisfies WikiCommitIdentity & WikiWriter

const refusal = (cause: WikiError): string | undefined => {
  switch (cause.reason) {
    case WIKI_ERROR_REASON.invalid:
    case WIKI_ERROR_REASON.blocked:
    case WIKI_ERROR_REASON.not_found:
    case WIKI_ERROR_REASON.conflict:
      return cause.message
    case WIKI_ERROR_REASON.closed:
    case WIKI_ERROR_REASON.corrupt:
    case WIKI_ERROR_REASON.storage:
      return undefined
  }
}

const stateOf = (change: WorkingFileChange): string => {
  switch (change.kind) {
    case WORKING_FILE_CHANGE_KIND.changed:
      return `changed:${sha256Hex(change.content)}`
    case WORKING_FILE_CHANGE_KIND.missing:
      return "missing"
    case WORKING_FILE_CHANGE_KIND.unreadable:
      return `unreadable:${change.reason}`
  }
}

const STAGES = ["update", "archive", "archive_readme"] as const

const stage = (change: WorkingFileChange): (typeof STAGES)[number] => {
  if (change.kind !== WORKING_FILE_CHANGE_KIND.missing) return "update"
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
      file.kind === UNTRACKED_FILE_KIND.read ? [[sha256Hex(file.content), file.path] as const] : []
    )
  )
  return { byPageId, byBlob }
})

export const makeOutsideEdits = (input: {
  readonly repository: ManagedFileRepositoryShape
  readonly spaces: SpaceStore["Service"]
  readonly snapshot: () => Effect.Effect<Snapshot, WikiError>
}): {
  check: () => Effect.Effect<OutsideEditCheck, WikiError, never>
  state: (path: string) => OutsideEditState | undefined
  explain: (error: WikiError) => WikiError
} => {
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
    if (record === undefined)
      return setAside(SET_ASIDE_REASON.refused, "The file is not a Memory page")
    switch (change.kind) {
      case WORKING_FILE_CHANGE_KIND.unreadable:
        return setAside(SET_ASIDE_REASON.unreadable, change.reason)
      case WORKING_FILE_CHANGE_KIND.changed: {
        const content = utf8(change.content)
        if (content === undefined)
          return setAside(SET_ASIDE_REASON.unreadable, "The file is not UTF-8 text")
        const refused = yield* allowed(
          replacementContent(
            "update",
            record.page.pageId,
            content,
            codeOwnedPage(resource.path)?.plainTitle
          )
        )
        return refused === undefined
          ? { kind: OUTSIDE_EDIT.takeIn, change }
          : setAside(SET_ASIDE_REASON.refused, refused)
      }
      case WORKING_FILE_CHANGE_KIND.missing: {
        const movedTo = found.movedTo(resource.resourceId, resource.blobId)
        if (movedTo !== undefined)
          return setAside(
            SET_ASIDE_REASON.moved,
            `The page is now at ${movedTo}; Arden does not take in a page moved outside`
          )
        if (found.manyMissing !== undefined)
          return setAside(
            SET_ASIDE_REASON.manyMissing,
            `${found.manyMissing} pages are missing at once, more than the ${MAX_MISSING_ARCHIVED} one check archives; archive them in the app if that was meant`
          )
        return { kind: OUTSIDE_EDIT.takeIn, change }
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
    const missing = status.changes.filter(
      (change) => change.kind === WORKING_FILE_CHANGE_KIND.missing
    ).length
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
      if (decided.kind === OUTSIDE_EDIT.setAside) {
        setAside.push(decided)
        continue
      }
      const adopted = yield* commitOutsideChange(
        { repository, spaces },
        { ...OUTSIDE_EDIT_IDENTITY, expectedRevision: pages.head },
        decided.change
      ).pipe(Effect.result)
      if (Result.isFailure(adopted)) {
        const outcome = adoptionFailure(adopted.failure)
        if (outcome === ADOPTION.fail)
          return yield* mapRevisionError("observe", change.resource.resourceId)(adopted.failure)
        if (outcome === ADOPTION.refused) {
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
          action: change.kind === WORKING_FILE_CHANGE_KIND.missing ? "archive" : "update",
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
  state?.kind === OUTSIDE_EDIT_STATE.setAside
    ? `${path} was changed outside Arden and Memory set that change aside: ${state.detail}. Nothing was saved. Arden cannot write this page until its file is fixed or put back.`
    : `${path} was changed outside Arden and Memory has not taken that change in yet. Nothing was saved. Memory checks the files every minute and takes a change in once it stays the same for one check.`

const adoptionFailure = (cause: WikiCommitError): (typeof ADOPTION)[keyof typeof ADOPTION] =>
  Match.valueTags(cause, {
    RevisionConflictError: () => ADOPTION.again,
    WorkingFileChangedError: () => ADOPTION.again,
    WikiError: (found) => (refusal(found) === undefined ? ADOPTION.fail : ADOPTION.refused),
    WikiCommitRuleError: () => ADOPTION.refused,
    InvalidRevisionInputError: () => ADOPTION.refused,
    NoChangesError: () => ADOPTION.refused,
    RevisionContentLimitError: () => ADOPTION.refused,
    UnsafePathError: () => ADOPTION.refused,
    CorruptRepositoryError: () => ADOPTION.fail,
    IdempotencyConflictError: () => ADOPTION.fail,
    RepositoryClosedError: () => ADOPTION.fail,
    RevisionStorageError: () => ADOPTION.fail,
    SpaceStoreError: () => ADOPTION.fail
  })

export const outsideEditNotice = (state: OutsideEditState): string =>
  state.kind === OUTSIDE_EDIT_STATE.setAside
    ? `This page's file was changed outside Arden and Memory set that change aside: ${state.detail}. This version stays in Memory, and writes to the page are refused until the file is fixed or put back.`
    : "This page's file was changed outside Arden; Memory takes the change in at its next check, and writes to the page are refused until then."
