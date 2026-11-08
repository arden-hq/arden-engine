import { cutText } from "@arden-hq/std/text"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"

import { IMPORTED_DIRECTORY, type CommittedPage } from "../wiki/imported.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { slugify } from "@arden-hq/std/slug"

type AgentApp = "claude_code" | "codex"

const APPS: Record<AgentApp, { readonly label: string; readonly directory: string }> = {
  claude_code: { label: "Claude Code", directory: `${IMPORTED_DIRECTORY}/claude-code` },
  codex: { label: "Codex", directory: `${IMPORTED_DIRECTORY}/codex` }
}

const MAX_BODY_CHARS = 40_000

interface KnowledgeFile {
  readonly app: AgentApp
  readonly path: string
  readonly display: string
  readonly page: string
  readonly bytes: number
}

interface KnowledgeSource {
  readonly app: AgentApp
  readonly label: string
  readonly files: ReadonlyArray<KnowledgeFile>
}

interface ProjectMemory {
  readonly project: string
  readonly display: string
  readonly files: ReadonlyArray<KnowledgeFile>
}

export interface AgentKnowledge {
  readonly instructions: ReadonlyArray<KnowledgeSource>
  readonly projectMemories: ReadonlyArray<ProjectMemory>
}

export const findAgentKnowledge = async (home: string): Promise<AgentKnowledge> => {
  const claude = join(home, ".claude")
  const codex = join(home, ".codex")
  const candidates: ReadonlyArray<Candidate> = [
    { app: "claude_code", path: join(claude, "CLAUDE.md"), page: "claude.md" },
    ...(await markdownFiles(join(claude, "rules"))).map((name) => ({
      app: "claude_code" as const,
      path: join(claude, "rules", name),
      page: `rules-${slug(name)}.md`
    })),
    { app: "codex", path: join(codex, "AGENTS.md"), page: "agents.md" },
    ...(await markdownFiles(join(codex, "memories"))).map((name) => ({
      app: "codex" as const,
      path: join(codex, "memories", name),
      page: `memories-${slug(name)}.md`
    }))
  ]
  const instructions = uniquePages(await existing(home, candidates))
  const projectMemories = await Promise.all(
    (await markdownDirectories(join(claude, "projects"))).map(async (folder) => {
      const directory = join(claude, "projects", folder, "memory")
      const project = projectName(folder)
      const files = await existing(
        home,
        (await markdownFiles(directory)).map((name) => ({
          app: "claude_code" as const,
          path: join(directory, name),
          page: `project-${slug(project)}-${slug(name)}.md`
        }))
      )
      return { project, display: `~${directory.slice(home.length)}`, files }
    })
  )
  return {
    instructions: (["claude_code", "codex"] as const).flatMap((app) => {
      const own = instructions.filter((file) => file.app === app)
      return own.length === 0 ? [] : [{ app, label: APPS[app].label, files: own }]
    }),
    projectMemories: projectMemories.filter((memory) => memory.files.length > 0)
  }
}

export interface KnowledgeTarget {
  readonly write: (input: {
    readonly directories: ReadonlyArray<{ readonly path: string; readonly contract: string }>
    readonly pages: ReadonlyArray<{
      readonly path: string
      readonly title: string
      readonly body: string
    }>
  }) => Promise<Omit<KnowledgeImport, "skipped">>
}

type SkipReason = "secret" | "too_large" | "empty" | "unreadable"

interface Skipped {
  readonly path: string
  readonly reason: SkipReason
}

export interface KnowledgeImport {
  readonly created: ReadonlyArray<string>
  readonly updated: ReadonlyArray<string>
  readonly unchanged: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<Skipped>
  readonly committed: ReadonlyArray<CommittedPage>
}

export const importAgentKnowledge = async ({
  home,
  includeProjectMemories,
  target
}: {
  readonly home: string
  readonly includeProjectMemories: boolean
  readonly target: KnowledgeTarget
}): Promise<KnowledgeImport> => {
  const knowledge = await findAgentKnowledge(home)
  const files = uniquePages([
    ...knowledge.instructions.flatMap((source) => source.files),
    ...(includeProjectMemories ? knowledge.projectMemories.flatMap((memory) => memory.files) : [])
  ])
  const read = await Promise.all(
    files.map(async (file) => ({ file, content: await readKnowledge(file.path) }))
  )
  const skipped = read.flatMap(({ file, content }) =>
    content.kind === "skipped" ? [{ path: file.display, reason: content.reason }] : []
  )
  const pages = read.flatMap(({ file, content }) => {
    if (content.kind === "skipped") return []
    const label = APPS[file.app].label
    const sha256 = sha256Hex(content.text)
    const body = [
      `Imported from ${label}: \`${file.display}\``,
      `Content SHA-256: \`${sha256}\``,
      "",
      "---",
      "",
      content.text.trim()
    ].join("\n")
    return [{ path: file.page, title: noteTitle(content.text, basename(file.path)), body }]
  })
  if (pages.length === 0) return { created: [], updated: [], unchanged: [], skipped, committed: [] }
  const apps = new Set(files.map((file) => file.app))
  const written = await target.write({
    directories: [
      { path: IMPORTED_DIRECTORY, contract: IMPORTED_CONTRACT },
      ...(["claude_code", "codex"] as const)
        .filter((app) => apps.has(app))
        .map((app) => ({ path: APPS[app].directory, contract: appContract(APPS[app].label) }))
    ],
    pages
  })
  return { ...written, skipped }
}

const INSTRUCTION_SHARE = 5_000
const PROJECT_SHARE = 1_200
const DIGEST_BUDGET = 12_000

export const digestAgentKnowledge = async ({
  home,
  budget = DIGEST_BUDGET
}: {
  readonly home: string
  readonly budget?: number
}): Promise<string> => {
  const knowledge = await findAgentKnowledge(home)
  const entries: ReadonlyArray<{ readonly path: string; readonly share: number }> = [
    ...knowledge.instructions.flatMap((source) =>
      source.files.map((file) => ({ path: file.path, share: INSTRUCTION_SHARE }))
    ),
    ...knowledge.projectMemories.flatMap((memory) => {
      const index = memory.files.find((file) => file.path.endsWith("/MEMORY.md")) ?? memory.files[0]
      return index === undefined ? [] : [{ path: index.path, share: PROJECT_SHARE }]
    })
  ]
  const sections: Array<string> = []
  const unread: Array<string> = []
  const trailerRoom = Math.floor(budget / 8)
  let left = budget - trailerRoom
  for (const entry of entries) {
    const display = `~${entry.path.slice(home.length)}`
    const content = await readKnowledge(entry.path)
    if (content.kind === "skipped") {
      const line = `## ${display}\n(skipped: ${SKIP_WORDS[content.reason]})`
      if (line.length <= left) {
        sections.push(line)
        left -= line.length + 2
      }
      continue
    }
    const heading = `## ${display}\n`
    const room = Math.min(entry.share, left - heading.length - 2)
    if (room < 200) {
      unread.push(display)
      continue
    }
    const text = content.text.trim()
    const section = `${heading}${cutText(text, room, { suffix: "\n[…cut]" })}`
    sections.push(section)
    left -= section.length + 2
  }
  if (sections.length === 0 && unread.length === 0) {
    return "No Claude Code or Codex notes were found."
  }
  return [...sections, ...(unread.length === 0 ? [] : [unreadLine(unread, trailerRoom - 2)])].join(
    "\n\n"
  )
}

const unreadLine = (paths: ReadonlyArray<string>, room: number): string => {
  const shown: Array<string> = []
  for (const [index, path] of paths.entries()) {
    const rest = paths.length - index - 1
    const line = `Not read (over the budget): ${[...shown, path].join(", ")}${rest === 0 ? "" : `, and ${rest} more`}`
    if (line.length > room) break
    shown.push(path)
  }
  const rest = paths.length - shown.length
  return `Not read (over the budget): ${shown.length === 0 ? `${rest} files` : `${shown.join(", ")}${rest === 0 ? "" : `, and ${rest} more`}`}`
}

export const SKIP_WORDS: Record<SkipReason, string> = {
  secret: "it looks like it holds a secret",
  too_large: "too large for one Memory page",
  empty: "empty",
  unreadable: "could not be read"
}

type KnowledgeContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "skipped"; readonly reason: SkipReason }

const readKnowledge = async (path: string): Promise<KnowledgeContent> => {
  const text = await readFile(path, "utf8").catch(() => undefined)
  if (text === undefined) return { kind: "skipped", reason: "unreadable" }
  if (text.trim().length === 0) return { kind: "skipped", reason: "empty" }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "skipped", reason: "secret" }
  }
  return text.length > MAX_BODY_CHARS
    ? { kind: "skipped", reason: "too_large" }
    : { kind: "text", text }
}

const noteTitle = (content: string, fileName: string): string => {
  const lines = content.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "").split("\n")
  const opening = lines.find((line) => line.trim().length > 0)
  return opening?.match(/^# +(\S.*)$/)?.[1]?.trim() ?? fileName
}

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*["']?[A-Za-z0-9_\-/+=.]{12,}/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/
]

const IMPORTED_CONTRACT = `## Purpose

Notes copied from other assistants the user works with, so Arden can read what they were taught.

## Producers

Arden's import from other assistants, only when the user asks for it.

## Consumers

Arden, when it needs the user's standing preferences or project context.

## Boundaries

Reference copies, read-only: Memory upkeep never edits them, and their links may point at notes Arden does not have. They do not change how Arden works until the user says so. Never settings, sessions or credentials.

## Retention

Kept until the user deletes them; importing again refreshes changed copies.
`

const appContract = (label: string): string => `## Purpose

What the user taught ${label}: its instructions, rules and memory files, one page per file.

## Producers

Arden's import from ${label}, only when the user asks for it. Each page names the file it came from and the file's content hash.

## Consumers

Arden, when it needs the user's standing preferences or project context.

## Boundaries

Reference copies, read-only: Memory upkeep never edits them. They do not change how Arden works until the user says so. Files that look like they hold secrets are never copied.

## Retention

Kept until the user deletes them; importing again refreshes changed copies.
`

interface Candidate {
  readonly app: AgentApp
  readonly path: string
  readonly page: string
}

const existing = async (
  home: string,
  candidates: ReadonlyArray<Candidate>
): Promise<ReadonlyArray<KnowledgeFile>> =>
  (
    await Promise.all(
      candidates.map(async (candidate) => {
        const info = await stat(candidate.path).catch(() => undefined)
        return info?.isFile() === true
          ? [
              {
                app: candidate.app,
                path: candidate.path,
                display: `~${candidate.path.slice(home.length)}`,
                page: `${APPS[candidate.app].directory}/${candidate.page}`,
                bytes: info.size
              }
            ]
          : []
      })
    )
  ).flat()

const markdownFiles = async (directory: string): Promise<ReadonlyArray<string>> =>
  (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort()

const markdownDirectories = async (directory: string): Promise<ReadonlyArray<string>> =>
  (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

/** Claude Code names a project's folder after its path: `-Users-me-src-app` is `src-app`. */
const projectName = (folder: string): string => folder.replace(/^-(?:Users|home)-[^-]+-/, "")

const slug = (name: string): string =>
  slugify(name.replace(/\.md$/i, ""), { max: 80, fallback: "note" })

const uniquePages = (files: ReadonlyArray<KnowledgeFile>): ReadonlyArray<KnowledgeFile> => {
  const seen = new Map<string, number>()
  return files.map((file) => {
    const count = (seen.get(file.page) ?? 0) + 1
    seen.set(file.page, count)
    return count === 1 ? file : { ...file, page: file.page.replace(/\.md$/, `-${count}.md`) }
  })
}
