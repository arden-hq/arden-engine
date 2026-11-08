import type { MarketplaceSkill, SkillInstallReceipt } from "@arden-hq/protocol/skills"
import { Effect, Predicate } from "effect"
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { type SkillError, skillError } from "./errors.js"
import {
  downloadRemoteSkillFile,
  listPopularMarketplace,
  type MarketplaceCatalogItem,
  type MarketplaceFetch,
  resolveRemoteSkill,
  searchMarketplace
} from "./marketplace-source.js"
import { parseSkillMetadata } from "./metadata.js"
import { currentMillis } from "../runtime/clock.js"

const POPULAR_LIMIT = 12
const POPULAR_CACHE_MS = 60 * 60 * 1_000
const MAX_SKILL_FILE_BYTES = 512 * 1024

export interface SkillMarketplaceSource {
  readonly popular: (
    installedNames: ReadonlySet<string>
  ) => Effect.Effect<ReadonlyArray<MarketplaceSkill>, SkillError>
  readonly search: (
    query: string,
    installedNames: ReadonlySet<string>
  ) => Effect.Effect<ReadonlyArray<MarketplaceSkill>, SkillError>
  readonly install: (root: string, id: string) => Effect.Effect<SkillInstallReceipt, SkillError>
}

export interface SkillMarketplaceOptions {
  readonly fetch?: MarketplaceFetch
  readonly now?: () => number
  readonly cacheTtlMs?: number
}

interface DownloadedFile {
  readonly path: string
  readonly bytes: Uint8Array
  readonly executable: boolean
}

const pathStatus = Effect.fn("SkillMarketplace.pathStatus")(function* (path: string) {
  return yield* Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => cause
  }).pipe(
    Effect.map((status) => ({ kind: "present" as const, status })),
    Effect.catch((cause) => {
      if (
        Predicate.hasProperty(cause, "code") &&
        Predicate.isString(cause.code) &&
        cause.code === "ENOENT"
      ) {
        return Effect.succeed({ kind: "missing" as const })
      }
      return Effect.fail(skillError("install", "storage", "Skill storage is unavailable", cause))
    })
  )
})

const install = Effect.fn("SkillMarketplace.install")(function* (
  fetcher: MarketplaceFetch,
  root: string,
  id: string
) {
  const skill = yield* resolveRemoteSkill(fetcher, id)
  const target = join(root, skill.name)
  const status = yield* pathStatus(target)
  if (status.kind === "present") {
    return yield* skillError("install", "invalid", `Skill ${skill.name} is already installed`)
  }

  const workspace = yield* Effect.tryPromise({
    try: () => mkdtemp(join(root, ".marketplace-")),
    catch: (cause) =>
      skillError("install", "storage", "Skill staging directory is unavailable", cause)
  })
  const staging = join(workspace, skill.name)
  return yield* Effect.gen(function* () {
    const downloaded = yield* Effect.forEach(
      skill.files,
      (file) =>
        downloadRemoteSkillFile(fetcher, skill, file).pipe(
          Effect.map(
            (bytes) =>
              ({
                path: file.path,
                bytes,
                executable: file.executable
              }) satisfies DownloadedFile
          )
        ),
      { concurrency: 8 }
    )
    const skillFile = downloaded.find((file) => file.path === "SKILL.md")
    if (skillFile === undefined) {
      return yield* skillError("install", "invalid", "Marketplace skill has no SKILL.md")
    }
    if (skillFile.bytes.byteLength > MAX_SKILL_FILE_BYTES) {
      return yield* skillError("install", "invalid", "SKILL.md is too large")
    }
    const content = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(skillFile.bytes),
      catch: (cause) => skillError("install", "invalid", "SKILL.md is not valid UTF-8", cause)
    })
    const metadata = yield* parseSkillMetadata(content, skill.name, "install")

    yield* Effect.tryPromise({
      try: () => mkdir(staging),
      catch: (cause) => skillError("install", "storage", "Skill could not be staged", cause)
    })
    yield* Effect.forEach(
      downloaded,
      (file) => {
        const destination = join(staging, ...file.path.split("/"))
        return Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(destination), { recursive: true })
            await writeFile(destination, file.bytes, {
              flag: "wx",
              mode: file.executable ? 0o700 : 0o600
            })
            const written = await lstat(destination)
            if (
              !written.isFile() ||
              written.isSymbolicLink() ||
              written.size !== file.bytes.byteLength
            ) {
              throw new Error("Written file did not match the validated marketplace file")
            }
          },
          catch: (cause) => skillError("install", "storage", "Skill could not be staged", cause)
        })
      },
      { concurrency: 8, discard: true }
    )
    yield* Effect.tryPromise({
      try: () => rename(staging, target),
      catch: (cause) => skillError("install", "storage", "Skill could not be installed", cause)
    })
    return {
      status: "installed",
      name: metadata.name,
      description: metadata.description,
      version: metadata.version ?? null
    } satisfies SkillInstallReceipt
  }).pipe(
    Effect.ensuring(
      Effect.promise(() => rm(workspace, { recursive: true, force: true }).catch(() => undefined))
    )
  )
})

const withInstalled = (
  items: ReadonlyArray<MarketplaceCatalogItem>,
  installedNames: ReadonlySet<string>
): ReadonlyArray<MarketplaceSkill> =>
  items.map((item) => ({
    ...item,
    installed: installedNames.has(item.name)
  }))

export const makeSkillMarketplace = (
  options: SkillMarketplaceOptions = {}
): SkillMarketplaceSource => {
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const now = options.now ?? currentMillis
  const cacheTtlMs = options.cacheTtlMs ?? POPULAR_CACHE_MS
  let cachedPopular:
    | {
        readonly expiresAt: number
        readonly items: ReadonlyArray<MarketplaceCatalogItem>
      }
    | undefined

  const popular = Effect.fn("SkillMarketplace.popularSource")(function* () {
    if (cachedPopular !== undefined && cachedPopular.expiresAt > now()) {
      return cachedPopular.items
    }
    const items = yield* listPopularMarketplace(fetcher, POPULAR_LIMIT)
    if (items.length === 0) {
      return yield* skillError(
        "marketplace",
        "unavailable",
        "Skill marketplace has no available skills"
      )
    }
    cachedPopular = { expiresAt: now() + cacheTtlMs, items }
    return items
  })

  return {
    popular: Effect.fn("SkillMarketplace.popular")(function* (installedNames) {
      return withInstalled(yield* popular(), installedNames)
    }),
    search: Effect.fn("SkillMarketplace.search")(function* (query, installedNames) {
      return withInstalled(yield* searchMarketplace(fetcher, query), installedNames)
    }),
    install: (root, id) => install(fetcher, root, id)
  }
}
