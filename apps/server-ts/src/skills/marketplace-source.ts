import type { MarketplaceSkill } from "@arden-hq/protocol/skills"
import {
  MarketplaceSkillIdSchema,
  MarketplaceSkillSearchTextSchema,
  MarketplaceSkillSourceSchema,
  SkillNameSchema
} from "@arden-hq/protocol/effect/skills"
import { Effect, Schema } from "effect"

import { type SkillError, skillError } from "./errors.js"

const SEARCH_ROOT = "https://skills.sh/api/search"
const POPULAR_ROOT = "https://skills.sh/api/skills/all-time/0"
const GITHUB_API_ROOT = "https://api.github.com/repos"
const GITHUB_RAW_ROOT = "https://raw.githubusercontent.com"
const REQUEST_TIMEOUT_MS = 20_000
const MAX_SEARCH_ITEMS = 200
const MAX_REPO_TREE_ITEMS = 50_000
const MAX_SKILL_FILES = 128
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_SKILL_BYTES = 10 * 1024 * 1024

const ProviderSkillFields = {
  skillId: Schema.String,
  name: Schema.String,
  installs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  source: Schema.String
} as const

const ProviderSearchSkillSchema = Schema.Struct({
  id: Schema.String,
  ...ProviderSkillFields
})

const ProviderPopularSkillSchema = Schema.Struct(ProviderSkillFields)

const ProviderSearchSchema = Schema.Struct({
  skills: Schema.Array(ProviderSearchSkillSchema).check(
    Schema.makeFilter((skills) =>
      skills.length <= MAX_SEARCH_ITEMS
        ? undefined
        : `must contain at most ${MAX_SEARCH_ITEMS} skills`
    )
  )
})

const ProviderPopularSchema = Schema.Struct({
  skills: Schema.Array(ProviderPopularSkillSchema).check(
    Schema.makeFilter((skills) =>
      skills.length <= MAX_SEARCH_ITEMS
        ? undefined
        : `must contain at most ${MAX_SEARCH_ITEMS} skills`
    )
  )
})

const CommitSchema = Schema.Struct({
  sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
})

const RepositoryPathSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
  Schema.makeFilter((value) => {
    const parts = value.split("/")
    if (value.startsWith("/") || value.includes("\\") || parts.length > 32) {
      return "must be a bounded relative path"
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) return "must not contain control characters"
    return parts.some((part) => part === "" || part === "." || part === "..")
      ? "must not contain empty or traversing path components"
      : undefined
  })
)

const RepositoryTreeEntrySchema = Schema.Struct({
  path: RepositoryPathSchema,
  mode: Schema.String,
  type: Schema.String,
  size: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

const RepositoryTreeSchema = Schema.Struct({
  tree: Schema.Array(RepositoryTreeEntrySchema).check(
    Schema.makeFilter((tree) =>
      tree.length <= MAX_REPO_TREE_ITEMS
        ? undefined
        : `must contain at most ${MAX_REPO_TREE_ITEMS} entries`
    )
  ),
  truncated: Schema.Boolean
}).check(
  Schema.makeFilter((value) =>
    value.truncated ? { path: ["truncated"], issue: "must be false" } : undefined
  )
)

const RelativeFilePathSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => {
    const parts = value.split("/")
    if (value.startsWith("/") || value.includes("\\") || parts.length > 8) {
      return "must be a shallow relative path"
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) return "must not contain control characters"
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      return "must not contain empty or traversing path components"
    }
    return parts.includes(".git") || value === ".disabled"
      ? "contains a reserved local path"
      : undefined
  })
)

const SkillTreeEntrySchema = Schema.Union([
  Schema.Struct({
    path: RelativeFilePathSchema,
    mode: Schema.Literals(["100644", "100755"] as const),
    type: Schema.Literal("blob"),
    size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  }),
  Schema.Struct({
    path: RelativeFilePathSchema,
    mode: Schema.Literal("040000"),
    type: Schema.Literal("tree")
  })
])

const SkillTreeSchema = Schema.Struct({
  tree: Schema.Array(SkillTreeEntrySchema),
  truncated: Schema.Literal(false)
}).check(
  Schema.makeFilter((value) => {
    const files = value.tree.filter((entry) => entry.type === "blob")
    if (files.length > MAX_SKILL_FILES) {
      return { path: ["tree"], issue: `must contain at most ${MAX_SKILL_FILES} files` }
    }
    if (files.some((file) => file.size > MAX_FILE_BYTES)) {
      return { path: ["tree"], issue: `contains a file larger than ${MAX_FILE_BYTES} bytes` }
    }
    const paths = new Set(value.tree.map((entry) => entry.path))
    if (paths.size !== value.tree.length) {
      return { path: ["tree"], issue: "contains duplicate paths" }
    }
    for (const file of files) {
      const parts = file.path.split("/")
      for (let index = 1; index < parts.length; index += 1) {
        if (files.some((candidate) => candidate.path === parts.slice(0, index).join("/"))) {
          return { path: ["tree"], issue: "contains a file used as a directory" }
        }
      }
    }
    const total = files.reduce((sum, file) => sum + file.size, 0)
    return total <= MAX_SKILL_BYTES
      ? undefined
      : { path: ["tree"], issue: `must total at most ${MAX_SKILL_BYTES} bytes` }
  })
)

const isSkillName = Schema.is(SkillNameSchema)
const isMarketplaceSource = Schema.is(MarketplaceSkillSourceSchema)

const toMarketplaceItem = (skill: {
  readonly skillId: string
  readonly source: string
  readonly installs: number
}): MarketplaceCatalogItem | undefined => {
  if (!isSkillName(skill.skillId) || !isMarketplaceSource(skill.source)) return undefined
  const id = `${skill.source}/${skill.skillId}`
  return {
    id,
    name: skill.skillId,
    author: skill.source.slice(0, skill.source.indexOf("/")),
    source: skill.source,
    installs: skill.installs,
    url: `https://skills.sh/${id}`
  }
}

export type MarketplaceFetch = (input: string, init?: RequestInit) => Promise<Response>
export interface MarketplaceCatalogItem {
  readonly id: MarketplaceSkill["id"]
  readonly name: MarketplaceSkill["name"]
  readonly author: MarketplaceSkill["author"]
  readonly source: MarketplaceSkill["source"]
  readonly installs: MarketplaceSkill["installs"]
  readonly url: MarketplaceSkill["url"]
}

export interface RemoteSkillFile {
  readonly path: string
  readonly size: number
  readonly executable: boolean
}

export interface RemoteSkill {
  readonly id: string
  readonly name: string
  readonly source: string
  readonly commit: string
  readonly rootPath: string
  readonly files: ReadonlyArray<RemoteSkillFile>
}

const request = Effect.fn("SkillMarketplace.request")(function* (
  fetcher: MarketplaceFetch,
  url: string,
  operation: "marketplace" | "install"
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetcher(url, {
        headers: {
          accept: "application/json",
          "user-agent": "Arden-Skills"
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }),
    catch: (cause) =>
      skillError(operation, "unavailable", "Skill marketplace is unavailable", cause)
  })
  if (!response.ok) {
    const reason =
      operation === "install" && response.status === 404
        ? ("not_found" as const)
        : ("unavailable" as const)
    return yield* skillError(operation, reason, "Skill marketplace is unavailable")
  }
  return response
})

const requestJson = Effect.fn("SkillMarketplace.requestJson")(function* (
  fetcher: MarketplaceFetch,
  url: string,
  operation: "marketplace" | "install"
) {
  const response = yield* request(fetcher, url, operation)
  return yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      skillError(operation, "unavailable", "Skill marketplace returned invalid data", cause)
  })
})

const decodeProvider = <A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  operation: "marketplace" | "install"
): Effect.Effect<A, SkillError> =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "preserve" }).pipe(
    Effect.mapError((cause) =>
      skillError(operation, "unavailable", "Skill marketplace returned invalid data", cause)
    )
  )

export const searchMarketplace = Effect.fn("SkillMarketplace.searchSource")(function* (
  fetcher: MarketplaceFetch,
  query: string,
  limit = 25
) {
  const safeQuery = yield* Schema.decodeUnknownEffect(MarketplaceSkillSearchTextSchema)(query).pipe(
    Effect.mapError((cause) =>
      skillError("marketplace", "invalid", "Marketplace search is invalid", cause)
    )
  )
  const safeLimit = Math.max(1, Math.min(MAX_SEARCH_ITEMS, Math.trunc(limit)))
  const url = new URL(SEARCH_ROOT)
  url.searchParams.set("q", safeQuery)
  url.searchParams.set("limit", String(safeLimit))
  const value = yield* requestJson(fetcher, url.href, "marketplace")
  const response = yield* decodeProvider(ProviderSearchSchema, value, "marketplace")
  const seen = new Set<string>()
  return response.skills.flatMap((skill): ReadonlyArray<MarketplaceCatalogItem> => {
    const item = toMarketplaceItem(skill)
    if (item === undefined || skill.id !== item.id || seen.has(item.id)) return []
    seen.add(item.id)
    return [item]
  })
})

export const listPopularMarketplace = Effect.fn("SkillMarketplace.popularSource")(function* (
  fetcher: MarketplaceFetch,
  limit = 12
) {
  const safeLimit = Math.max(1, Math.min(MAX_SEARCH_ITEMS, Math.trunc(limit)))
  const value = yield* requestJson(fetcher, POPULAR_ROOT, "marketplace")
  const response = yield* decodeProvider(ProviderPopularSchema, value, "marketplace")
  const seen = new Set<string>()
  return response.skills
    .flatMap((skill): ReadonlyArray<MarketplaceCatalogItem> => {
      const item = toMarketplaceItem(skill)
      if (item === undefined || seen.has(item.id)) return []
      seen.add(item.id)
      return [item]
    })
    .sort((left, right) => right.installs - left.installs || left.id.localeCompare(right.id))
    .slice(0, safeLimit)
})

export const resolveRemoteSkill = Effect.fn("SkillMarketplace.resolveRemoteSkill")(function* (
  fetcher: MarketplaceFetch,
  id: string
) {
  const safeId = yield* Schema.decodeUnknownEffect(MarketplaceSkillIdSchema)(id).pipe(
    Effect.mapError((cause) =>
      skillError("install", "invalid", "Marketplace skill ID is invalid", cause)
    )
  )
  const separator = safeId.lastIndexOf("/")
  const source = safeId.slice(0, separator)
  const name = safeId.slice(separator + 1)
  const results = yield* searchMarketplace(fetcher, name, MAX_SEARCH_ITEMS).pipe(
    Effect.mapError((error) => skillError("install", error.reason, error.message, error))
  )
  if (!results.some((item) => item.id === safeId)) {
    return yield* skillError("install", "not_found", "Marketplace skill was not found")
  }

  const sourcePath = source.split("/").map(encodeURIComponent).join("/")
  const commitValue = yield* requestJson(
    fetcher,
    `${GITHUB_API_ROOT}/${sourcePath}/commits/HEAD`,
    "install"
  )
  const commit = yield* decodeProvider(CommitSchema, commitValue, "install")
  const treeValue = yield* requestJson(
    fetcher,
    `${GITHUB_API_ROOT}/${sourcePath}/git/trees/${commit.sha}?recursive=1`,
    "install"
  )
  const repository = yield* decodeProvider(RepositoryTreeSchema, treeValue, "install")
  const suffix = `/${name}/SKILL.md`
  const roots = new Set(
    repository.tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((path) => path === `${name}/SKILL.md` || path.endsWith(suffix))
      .map((path) => path.slice(0, -"/SKILL.md".length))
  )
  if (roots.size !== 1) {
    return yield* skillError(
      "install",
      "invalid",
      roots.size === 0 ? "Marketplace skill has no SKILL.md" : "Marketplace skill path is ambiguous"
    )
  }
  const rootPath = [...roots][0]
  if (rootPath === undefined) {
    return yield* skillError("install", "invalid", "Marketplace skill path is invalid")
  }
  const prefix = `${rootPath}/`
  const selectedValue = {
    truncated: false as const,
    tree: repository.tree
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => ({
        ...entry,
        path: entry.path.slice(prefix.length)
      }))
  }
  const selected = yield* decodeProvider(SkillTreeSchema, selectedValue, "install")
  const files = selected.tree.flatMap((entry): ReadonlyArray<RemoteSkillFile> =>
    entry.type === "blob"
      ? [{ path: entry.path, size: entry.size, executable: entry.mode === "100755" }]
      : []
  )
  if (!files.some((file) => file.path === "SKILL.md")) {
    return yield* skillError("install", "invalid", "Marketplace skill has no SKILL.md")
  }
  return {
    id: safeId,
    name,
    source,
    commit: commit.sha,
    rootPath,
    files
  } satisfies RemoteSkill
})

export const downloadRemoteSkillFile = Effect.fn("SkillMarketplace.downloadRemoteSkillFile")(
  function* (fetcher: MarketplaceFetch, skill: RemoteSkill, file: RemoteSkillFile) {
    const source = skill.source.split("/").map(encodeURIComponent).join("/")
    const path = `${skill.rootPath}/${file.path}`.split("/").map(encodeURIComponent).join("/")
    const response = yield* request(
      fetcher,
      `${GITHUB_RAW_ROOT}/${source}/${skill.commit}/${path}`,
      "install"
    )
    const bytes = yield* Effect.tryPromise({
      try: async () => new Uint8Array(await response.arrayBuffer()),
      catch: (cause) =>
        skillError(
          "install",
          "unavailable",
          "Marketplace skill file could not be downloaded",
          cause
        )
    })
    if (bytes.byteLength !== file.size || bytes.byteLength > MAX_FILE_BYTES) {
      return yield* skillError(
        "install",
        "unavailable",
        "Marketplace skill file size changed during download"
      )
    }
    return bytes
  }
)
