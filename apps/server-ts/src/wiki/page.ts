import { cutText, foldSpace } from "@arden-hq/std/text"
import type { WikiPage } from "@arden-hq/protocol/wiki"
import { Effect, Schema } from "effect"
import { parseDocument, stringify } from "yaml"
import { fromMarkdown } from "mdast-util-from-markdown"
import { posix } from "node:path"

import { formatObservationPeriod, type ObservationPeriod } from "./observation-period.js"
import { WikiPageFormatError } from "./errors.js"

const FrontmatterSchema = Schema.StructWithRest(
  Schema.Struct({
    page_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
    aliases: Schema.Array(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))
    ).check(Schema.isMaxLength(100)),
    lifecycle: Schema.Literals(["active", "redirect"] as const),
    redirect_to: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
    )
  }),
  [Schema.Record(Schema.String, Schema.Json)]
)

const decodeFrontmatter = Schema.decodeUnknownEffect(FrontmatterSchema)
const RESERVED = new Set(["page_id", "title", "aliases", "lifecycle", "redirect_to"])
const GENERATED_TOKEN = /<!--\s*\/?\s*generated\s*-->/iu
const REVISION_FIELDS = new Set([
  "content_hash",
  "content_sha256",
  "content_revision",
  "current_hash",
  "current_revision",
  "hash",
  "page_hash",
  "page_revision",
  "revision",
  "revision_id",
  "sha256"
])

export interface ParsedWikiPage {
  readonly pageId: string
  readonly title: string
  readonly aliases: ReadonlyArray<string>
  readonly lifecycle: "active" | "redirect"
  readonly redirectTo: string | null
  readonly metadata: WikiPage["metadata"]
  readonly body: string
  readonly content: string
}

export interface WikiPageContent {
  readonly pageId: string
  readonly title: string
  readonly aliases: ReadonlyArray<string>
  readonly lifecycle: "active" | "redirect"
  readonly redirectTo: string | null
  readonly metadata: WikiPage["metadata"]
  readonly body: string
}

export interface WikiPageChanges {
  readonly title?: string
  readonly aliases?: ReadonlyArray<string>
  readonly body?: string
  readonly observation_period?: ObservationPeriod
}

const fail = (message: string, cause?: unknown) =>
  new WikiPageFormatError({
    message,
    ...(cause === undefined ? {} : { cause })
  })

const splitPage = (content: string): readonly [frontmatter: string, body: string] => {
  if (!content.startsWith("---\n")) {
    throw fail("page must begin with a YAML frontmatter boundary")
  }
  const close = content.indexOf("\n---\n", 4)
  if (close < 0) throw fail("page frontmatter is missing its closing boundary")
  return [content.slice(4, close), content.slice(close + 5)]
}

const parseYaml = (source: string): unknown => {
  const document = parseDocument(source, {
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true
  })
  if (document.errors.length > 0) {
    throw fail("invalid YAML frontmatter", document.errors[0])
  }
  try {
    return document.toJS({ maxAliasCount: 0 })
  } catch (cause) {
    throw fail("invalid YAML frontmatter", cause)
  }
}

export const normal = (value: string): string => value.trim().toLowerCase()

export const pageNamesForPath = (path: string): ReadonlyArray<string> => {
  const names = [path, ...(path.endsWith(".md") ? [path.slice(0, -3)] : [])]
  if (posix.basename(path).toLowerCase() === "readme.md") {
    const directory = posix.dirname(path)
    if (directory !== ".") names.push(directory, `${directory}.md`)
  }
  return names
}

const PATH_SPELLING = /^(?:[a-z0-9][a-z0-9._-]*\/)*(?:[a-z0-9][a-z0-9._-]*|README)(?:\.md)?$/u

const isPathName = (name: string): boolean =>
  PATH_SPELLING.test(name) && (name.includes("/") || name.endsWith(".md") || name === "README")

interface PageAliases {
  readonly names: ReadonlyArray<string>
  readonly paths: ReadonlyArray<string>
}

export const pageAliases = (title: string, aliases: ReadonlyArray<string>): PageAliases => {
  const trimmed = aliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0)
  const paths = trimmed.filter(isPathName)
  const spellings = new Set(paths.flatMap((path) => pageNamesForPath(path)))
  for (const path of paths) spellings.add(`${path}.md`)
  const seen = new Set([normal(title)])
  const names: Array<string> = []
  for (const alias of trimmed) {
    const key = normal(alias)
    if (isPathName(alias) || spellings.has(alias) || seen.has(key)) continue
    seen.add(key)
    names.push(alias)
  }
  return { names, paths }
}

const sameNames = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index])

export const aliasesAreHuman = (title: string, aliases: ReadonlyArray<string>): boolean =>
  sameNames(pageAliases(title, aliases).names, aliases)

const validateAliases = (title: string, aliases: ReadonlyArray<string>): void => {
  const seen = new Set([title.trim().toLowerCase()])
  for (const alias of aliases) {
    const normalized = alias.trim().toLowerCase()
    if (normalized.length === 0) throw fail("aliases must contain nonempty strings")
    if (seen.has(normalized)) throw fail("title and aliases must not duplicate one another")
    seen.add(normalized)
  }
}

const validateGeneratedBoundaries = (body: string): void => {
  let opening = -1
  let closing = -1
  let line = 0
  for (const value of body.split("\n")) {
    line += 1
    if (
      GENERATED_TOKEN.test(value) &&
      value !== "<!-- generated -->" &&
      value !== "<!-- /generated -->"
    ) {
      throw fail("generated boundaries must occupy their own canonical line")
    }
    if (value === "<!-- generated -->") {
      if (opening !== -1) throw fail("generated content must have one opening boundary")
      opening = line
    }
    if (value === "<!-- /generated -->") {
      if (closing !== -1) throw fail("generated content must have one closing boundary")
      closing = line
    }
  }
  if ((opening === -1) !== (closing === -1) || (opening !== -1 && opening >= closing)) {
    throw fail("generated boundaries must contain one ordered opening and closing marker")
  }
}

const metadataOf = (frontmatter: Record<string, Schema.Json>): WikiPage["metadata"] => {
  return Object.freeze(
    Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !RESERVED.has(key)))
  )
}

export const parseWikiPage = Effect.fn("WikiPage.parse")(function* (
  content: string,
  expectedPageId?: string
): Effect.fn.Return<ParsedWikiPage, WikiPageFormatError> {
  const [yaml, body] = yield* Effect.try({
    try: () => splitPage(content),
    catch: (cause) =>
      cause instanceof WikiPageFormatError ? cause : fail("could not split Wiki page", cause)
  })
  const raw = yield* Effect.try({
    try: () => parseYaml(yaml),
    catch: (cause) =>
      cause instanceof WikiPageFormatError ? cause : fail("invalid YAML frontmatter", cause)
  })
  const frontmatter = yield* decodeFrontmatter(raw).pipe(
    Effect.mapError((cause) => fail("invalid Wiki frontmatter", cause))
  )
  if (frontmatter.page_id.trim().length === 0) return yield* fail("page_id must be nonempty")
  if (frontmatter.title.trim().length === 0) return yield* fail("title must be nonempty")
  if (expectedPageId !== undefined && frontmatter.page_id !== expectedPageId) {
    return yield* fail("page_id does not match the resource identity")
  }
  for (const key of REVISION_FIELDS) {
    if (Object.hasOwn(frontmatter, key)) {
      return yield* fail(`page content identity belongs in revision history: ${key}`)
    }
  }
  yield* Effect.try({
    try: () => {
      validateAliases(frontmatter.title, frontmatter.aliases)
      validateGeneratedBoundaries(body)
    },
    catch: (cause) =>
      cause instanceof WikiPageFormatError ? cause : fail("invalid Wiki page", cause)
  })
  const redirectTo = frontmatter.redirect_to ?? null
  if (frontmatter.lifecycle === "redirect" && redirectTo === null) {
    return yield* fail("redirect pages require redirect_to")
  }
  if (frontmatter.lifecycle === "active" && redirectTo !== null) {
    return yield* fail("active pages must not declare redirect_to")
  }
  return Object.freeze({
    pageId: frontmatter.page_id,
    title: frontmatter.title,
    aliases: Object.freeze([...frontmatter.aliases]),
    lifecycle: frontmatter.lifecycle,
    redirectTo,
    metadata: metadataOf(frontmatter),
    body,
    content
  })
})

export const formatRedirectPage = (page: {
  readonly pageId: string
  readonly title: string
  readonly redirectTo: string
}): string =>
  formatWikiPage({
    pageId: page.pageId,
    title: page.title,
    aliases: [],
    lifecycle: "redirect",
    redirectTo: page.redirectTo,
    metadata: {},
    body: ""
  })

export const formatWikiPage = (page: WikiPageContent): string => {
  const frontmatter = Object.fromEntries([
    ["page_id", page.pageId],
    ["title", page.title],
    ["aliases", [...pageAliases(page.title, page.aliases).names]],
    ["lifecycle", page.lifecycle],
    ...(page.redirectTo === null ? [] : [["redirect_to", page.redirectTo]]),
    ...Object.entries(page.metadata).filter(([key]) => !RESERVED.has(key))
  ])
  return `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n${page.body}`
}

export const reviseWikiPage = Effect.fn("WikiPage.revise")(function* (
  page: ParsedWikiPage,
  changes: WikiPageChanges
): Effect.fn.Return<string, WikiPageFormatError> {
  const body = changes.body ?? page.body
  const aliases = pageAliases(changes.title ?? page.title, changes.aliases ?? page.aliases).names
  const aliasesChange = !sameNames(aliases, page.aliases)
  if (changes.title === undefined && !aliasesChange && changes.observation_period === undefined) {
    return `${page.content.slice(0, page.content.length - page.body.length)}${body}`
  }
  const [source] = yield* Effect.try({
    try: () => splitPage(page.content),
    catch: (cause) =>
      cause instanceof WikiPageFormatError ? cause : fail("could not split Wiki page", cause)
  })
  const document = yield* Effect.try({
    try: () =>
      parseDocument(source, {
        schema: "core",
        strict: true,
        stringKeys: true,
        uniqueKeys: true
      }),
    catch: (cause) => fail("invalid YAML frontmatter", cause)
  })
  if (document.errors.length > 0) {
    return yield* fail("invalid YAML frontmatter", document.errors[0])
  }
  if (changes.observation_period !== undefined)
    document.set("observation_period", formatObservationPeriod(changes.observation_period))
  if (changes.title !== undefined) document.set("title", changes.title)
  if (aliasesChange) document.set("aliases", [...aliases])
  return `---\n${document.toString({ lineWidth: 0 }).trimEnd()}\n---\n${body}`
})

export const writtenContent = (page: ParsedWikiPage) => reviseWikiPage(page, {})

type MarkdownNode = {
  readonly type: string
  readonly value?: string | undefined
  readonly alt?: string | null | undefined
  readonly children?: ReadonlyArray<MarkdownNode> | undefined
}

const visibleText = (node: MarkdownNode): string => {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? ""
  if (node.type === "image") return node.alt ?? ""
  return node.children?.map(visibleText).join("") ?? ""
}

const firstParagraph = (node: MarkdownNode): MarkdownNode | undefined => {
  if (node.type === "paragraph") return node
  for (const child of node.children ?? []) {
    const found = firstParagraph(child)
    if (found !== undefined) return found
  }
  return undefined
}

export const wikiPageExcerpt = (body: string, limit = 240): string | null => {
  const tree: MarkdownNode = fromMarkdown(body)
  const paragraph = firstParagraph(tree)
  if (paragraph === undefined) return null
  const text = foldSpace(visibleText(paragraph))
  if (text.length === 0) return null
  return cutText(text, limit)
}
