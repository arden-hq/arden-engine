import { isWithin } from "@arden-hq/std/paths"
import { open, realpath, stat } from "node:fs/promises"
import path from "node:path"

import { PROMPT_CATALOG, PROMPT_TEXT } from "../prompts/catalog.js"
import { renderPromptSection } from "../prompts/format.js"
import type { SessionPathPolicy } from "../storage/local-paths.js"
import { sha256Hex } from "@arden-hq/std/hash"

const FILE_NAMES = ["AGENTS.override.md", "AGENTS.md"] as const
const MAX_TOTAL_BYTES = 32 * 1024
const MAX_FILE_BYTES = 16 * 1024
const MAX_SOURCES = 24

interface LocalInstructionSource {
  readonly path: string
  readonly scope: string
  readonly digest: string | undefined
  readonly status: "loaded" | "empty" | "unreadable" | "truncated"
  readonly content: string | undefined
}

export interface LocalInstructionSnapshot {
  readonly root: string
  readonly instructionRoot: string
  readonly directory: string
  readonly sources: ReadonlyArray<LocalInstructionSource>
  readonly digest: string
}

export interface LocalInstructionManifestEntry {
  readonly root: string
  readonly path: string
  readonly scope: string
  readonly status: LocalInstructionSource["status"]
  readonly digest: string | null
}

export const localInstructionManifest = (
  snapshots: ReadonlyArray<LocalInstructionSnapshot>
): ReadonlyArray<LocalInstructionManifestEntry> => {
  const entries = new Map<string, LocalInstructionManifestEntry>()
  for (const snapshot of snapshots) {
    for (const source of snapshot.sources) {
      entries.set(source.path, {
        root: snapshot.root,
        path: source.path,
        scope: source.scope,
        status: source.status,
        digest: source.digest ?? null
      })
    }
  }
  return [...entries.values()]
}

export const loadLocalInstructions = async ({
  policy,
  target,
  targetKind = "directory"
}: {
  readonly policy: SessionPathPolicy
  readonly target?: string
  readonly targetKind?: "directory" | "file"
}): Promise<LocalInstructionSnapshot | undefined> => {
  const requested = target ?? policy.cwd
  if (requested === null || requested === undefined) return undefined
  const directory = await realpath(targetKind === "file" ? path.dirname(requested) : requested)
  const root = [...policy.localRoots]
    .filter((candidate) => isWithin(candidate, directory))
    .sort((a, b) => b.length - a.length)[0]
  if (root === undefined) return undefined

  const ancestors = [root]
  let ancestor = root
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part)
    ancestors.push(ancestor)
  }
  const projectStart = Math.max(0, await nearestGitRoot(ancestors))
  const instructionRoot = ancestors[projectStart]
  if (instructionRoot === undefined) throw new Error("Missing local instruction root")
  const sources: LocalInstructionSource[] = []
  let remaining = MAX_TOTAL_BYTES
  for (const scope of ancestors.slice(projectStart)) {
    if (sources.length >= MAX_SOURCES || remaining === 0) break
    for (const name of FILE_NAMES) {
      if (sources.length >= MAX_SOURCES || remaining === 0) break
      const candidate = path.join(scope, name)
      const read = await readSource(candidate, scope, root, Math.min(remaining, MAX_FILE_BYTES))
      if (read === undefined) continue
      sources.push(read.source)
      remaining -= read.bytesUsed
      if (read.source.status === "loaded" || read.source.status === "truncated") break
    }
  }
  const digest = sha256Hex(
    JSON.stringify(sources.map((source) => [source.path, source.status, source.digest]))
  )
  return { root, instructionRoot, directory, sources, digest }
}

const nearestGitRoot = async (ancestors: ReadonlyArray<string>): Promise<number> => {
  for (const [index, ancestor] of [...ancestors.entries()].reverse()) {
    try {
      await stat(path.join(ancestor, ".git"))
      return index
    } catch {}
  }
  return 0
}

const readSource = async (
  candidate: string,
  scope: string,
  root: string,
  limit: number
): Promise<{ readonly source: LocalInstructionSource; readonly bytesUsed: number } | undefined> => {
  let resolved: string
  try {
    resolved = await realpath(candidate)
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined
    return {
      source: {
        path: candidate,
        scope,
        digest: undefined,
        status: "unreadable",
        content: undefined
      },
      bytesUsed: 0
    }
  }
  if (!isWithin(root, resolved)) {
    return {
      source: {
        path: candidate,
        scope,
        digest: undefined,
        status: "unreadable",
        content: undefined
      },
      bytesUsed: 0
    }
  }
  try {
    const file = await open(resolved, "r")
    try {
      const info = await file.stat()
      if (!info.isFile()) return undefined
      const bytes = Buffer.alloc(Math.min(limit, info.size))
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      const truncated = info.size > limit
      let content: string | undefined
      for (let trim = 0; trim <= (truncated ? 3 : 0); trim++) {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, bytesRead - trim)
          )
          break
        } catch {}
      }
      if (content === undefined) throw new Error("Invalid UTF-8 in instruction file")
      if (content.trim().length === 0 && !truncated) {
        return {
          source: {
            path: candidate,
            scope,
            digest: undefined,
            status: "empty",
            content: undefined
          },
          bytesUsed: bytesRead
        }
      }
      return {
        source: {
          path: candidate,
          scope,
          digest: sha256Hex(content),
          status: truncated ? "truncated" : "loaded",
          content: truncated ? `${content}\n${PROMPT_TEXT.localInstructionsTruncated}` : content
        },
        bytesUsed: bytesRead
      }
    } finally {
      await file.close()
    }
  } catch {
    return {
      source: {
        path: candidate,
        scope,
        digest: undefined,
        status: "unreadable",
        content: undefined
      },
      bytesUsed: 0
    }
  }
}

export const renderLocalInstructions = (
  snapshot: LocalInstructionSnapshot | undefined
): string | undefined => {
  if (snapshot === undefined || snapshot.sources.length === 0) return undefined
  return renderPromptSection(
    "Local folder instructions",
    [
      PROMPT_CATALOG.localInstructions.render({ root: JSON.stringify(snapshot.root) }).text,
      ...snapshot.sources.map((source) =>
        renderInstructionSource(source.path, source.status, source.content)
      )
    ].join("\n\n")
  )
}

export const renderInstructionSource = (
  file: string,
  status: LocalInstructionSource["status"],
  content: string | undefined
): string =>
  [`Source: ${JSON.stringify(file)} (${status})`, ...(content === undefined ? [] : [content])].join(
    "\n"
  )
