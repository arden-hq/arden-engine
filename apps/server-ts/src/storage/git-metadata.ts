import { PLATFORM } from "@arden-hq/std/process"
import { GIT_DIRECTORY } from "../skills/names.js"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"

export interface GitMetadataRule {
  readonly writeProtected: ReadonlyArray<string>
  readonly writeProtectedPatterns: ReadonlyArray<string>
  readonly writeRoots: ReadonlyArray<string>
}

const GIT_METADATA_PATTERNS = [
  String.raw`/\.git$`,
  String.raw`/\.git/(config|config\.worktree|commondir|hooks|modules|remotes|branches)(/.*)?$`,
  String.raw`/\.git/worktrees(/[^/]+(/(commondir|gitdir|config\.worktree))?)?$`
] as const

const readPointer = (file: string, pattern: RegExp): string | undefined => {
  try {
    return pattern.exec(readFileSync(file, "utf8"))?.[1]
  } catch {
    return undefined
  }
}

const realOrUndefined = (target: string): string | undefined => {
  try {
    return realpathSync(target)
  } catch {
    return undefined
  }
}

const DOTGIT = {
  missing: "missing",
  directory: "directory",
  worktree: "worktree",
  other: "other"
} as const

type DotGit =
  | { readonly kind: typeof DOTGIT.missing }
  | { readonly kind: typeof DOTGIT.directory }
  | { readonly kind: typeof DOTGIT.worktree; readonly admin: string; readonly common: string }
  | { readonly kind: typeof DOTGIT.other; readonly target: string | undefined }

const dotGitAt = (root: string): DotGit => {
  const dotGit = path.join(root, ".git")
  let stats
  try {
    stats = lstatSync(dotGit)
  } catch {
    return { kind: DOTGIT.missing }
  }
  if (stats.isDirectory()) return { kind: DOTGIT.directory }
  if (!stats.isFile()) return { kind: DOTGIT.other, target: realOrUndefined(dotGit) }
  const pointer = readPointer(dotGit, /^gitdir:\s*(.+?)\s*$/m)
  const admin = pointer === undefined ? undefined : realOrUndefined(path.resolve(root, pointer))
  if (admin === undefined) return { kind: DOTGIT.other, target: undefined }
  const commonPointer = readPointer(path.join(admin, "commondir"), /^(.+?)\s*$/m)
  const common =
    commonPointer === undefined ? undefined : realOrUndefined(path.resolve(admin, commonPointer))
  const backLink = readPointer(path.join(admin, "gitdir"), /^(.+?)\s*$/m)
  const linked =
    common !== undefined &&
    path.basename(common) === GIT_DIRECTORY &&
    path.dirname(admin) === path.join(common, "worktrees") &&
    backLink !== undefined &&
    realOrUndefined(path.resolve(admin, backLink)) === realOrUndefined(dotGit)
  return linked ? { kind: DOTGIT.worktree, admin, common } : { kind: DOTGIT.other, target: admin }
}

export const gitMetadataRule = (root: string, platform: NodeJS.Platform): GitMetadataRule => {
  const dotGit = path.join(root, ".git")
  const state = dotGitAt(root)
  if (state.kind === DOTGIT.other)
    return {
      writeProtected: [dotGit, ...(state.target === undefined ? [] : [state.target])],
      writeProtectedPatterns: [],
      writeRoots: []
    }
  if (platform !== PLATFORM.darwin)
    return {
      writeProtected: [dotGit, ...(state.kind === DOTGIT.worktree ? [state.admin] : [])],
      writeProtectedPatterns: [],
      writeRoots: []
    }
  return {
    writeProtected: [],
    writeProtectedPatterns: GIT_METADATA_PATTERNS,
    writeRoots: state.kind === DOTGIT.worktree ? [state.admin, state.common] : []
  }
}
