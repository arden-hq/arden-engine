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

type DotGit =
  | { readonly kind: "missing" }
  | { readonly kind: "directory" }
  | { readonly kind: "worktree"; readonly admin: string; readonly common: string }
  | { readonly kind: "other"; readonly target: string | undefined }

const dotGitAt = (root: string): DotGit => {
  const dotGit = path.join(root, ".git")
  let stats
  try {
    stats = lstatSync(dotGit)
  } catch {
    return { kind: "missing" }
  }
  if (stats.isDirectory()) return { kind: "directory" }
  if (!stats.isFile()) return { kind: "other", target: realOrUndefined(dotGit) }
  const pointer = readPointer(dotGit, /^gitdir:\s*(.+?)\s*$/m)
  const admin = pointer === undefined ? undefined : realOrUndefined(path.resolve(root, pointer))
  if (admin === undefined) return { kind: "other", target: undefined }
  const commonPointer = readPointer(path.join(admin, "commondir"), /^(.+?)\s*$/m)
  const common =
    commonPointer === undefined ? undefined : realOrUndefined(path.resolve(admin, commonPointer))
  const backLink = readPointer(path.join(admin, "gitdir"), /^(.+?)\s*$/m)
  const linked =
    common !== undefined &&
    path.basename(common) === ".git" &&
    path.dirname(admin) === path.join(common, "worktrees") &&
    backLink !== undefined &&
    realOrUndefined(path.resolve(admin, backLink)) === realOrUndefined(dotGit)
  return linked ? { kind: "worktree", admin, common } : { kind: "other", target: admin }
}

export const gitMetadataRule = (root: string, platform: NodeJS.Platform): GitMetadataRule => {
  const dotGit = path.join(root, ".git")
  const state = dotGitAt(root)
  if (state.kind === "other")
    return {
      writeProtected: [dotGit, ...(state.target === undefined ? [] : [state.target])],
      writeProtectedPatterns: [],
      writeRoots: []
    }
  if (platform !== "darwin")
    return {
      writeProtected: [dotGit, ...(state.kind === "worktree" ? [state.admin] : [])],
      writeProtectedPatterns: [],
      writeRoots: []
    }
  return {
    writeProtected: [],
    writeProtectedPatterns: GIT_METADATA_PATTERNS,
    writeRoots: state.kind === "worktree" ? [state.admin, state.common] : []
  }
}
