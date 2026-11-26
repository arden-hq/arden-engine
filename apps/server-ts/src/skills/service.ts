import type {
  MarketplaceSkill,
  Skill,
  SkillContent,
  SkillInstallReceipt,
  SkillRemoveReceipt,
  SkillToggleReceipt
} from "@arden-hq/protocol/skills"
import { SKILL_PLACE } from "@arden-hq/protocol/skills"
import {
  SkillDescriptionSchema,
  SkillNameSchema,
  SkillVersionSchema,
  splitMarketplaceSkillId
} from "@arden-hq/protocol/effect/skills"
import { Context, Effect, Layer, Predicate, Schema } from "effect"
import { mkdir, rm, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { authoredSkillDirectory } from "../prompts/catalog.js"

import { updateSkillInstructions, type SkillUpdateInput } from "./update.js"
import { readSkillReference } from "./resources.js"
import { stringify } from "yaml"

import {
  BUILT_IN_LIST,
  builtInLoaded,
  builtInSkillByName,
  builtInUnchangeable,
  isBuiltInSkillName,
  reservedName
} from "./builtin.js"
import { SkillError, skillError, type SkillOperation } from "./errors.js"
import {
  makeSkillMarketplace,
  type SkillMarketplaceOptions,
  type SkillMarketplaceSource
} from "./marketplace.js"
import {
  SKILL_FILE,
  DISABLED_FILE,
  MAX_SKILL_BYTES,
  SkillResourceFilesSchema,
  type SkillRecord,
  type SkillRoots,
  type SkillLoadedContent,
  type SkillCatalogPromptOptions,
  type SkillCreateInput
} from "./skill-schemas.js"
import {
  compactCatalog,
  listRoot,
  loadRecord,
  requireDirectory,
  storage,
  storageUnavailable
} from "./skill-records.js"

const make = Effect.fn("Skills.make")(function* (
  roots: SkillRoots,
  marketplace: SkillMarketplaceSource
) {
  const primary = roots.primary
  if (primary !== null) {
    yield* storage("list", "Skills storage is unavailable", () =>
      mkdir(primary, { recursive: true })
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Local Skills directory unavailable", { reason: error.reason })
      )
    )
  }
  const readable: ReadonlyArray<string> = primary === null ? roots.extra : [primary, ...roots.extra]
  const reported = new Set<string>()

  const records = Effect.fn("Skills.records")(function* () {
    const seenNames = new Set<string>()
    const seenIdentities = new Set<string>()
    const kept: Array<SkillRecord> = []
    for (const root of readable) {
      const found = yield* listRoot(root, root === primary, reported).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Skills root unavailable", { root, reason: error.reason }).pipe(
            Effect.as([] as ReadonlyArray<SkillRecord>)
          )
        )
      )
      for (const record of found) {
        if (seenNames.has(record.skill.name) || seenIdentities.has(record.identity)) continue
        seenNames.add(record.skill.name)
        seenIdentities.add(record.identity)
        kept.push(record)
      }
    }
    return kept
  })

  const located = (record: SkillRecord): Skill => ({
    ...record.skill,
    place: {
      kind: SKILL_PLACE.local,
      origin: record.root === primary ? "arden" : "shared",
      path: record.directory
    }
  })

  const list = Effect.fn("Skills.list")(function* () {
    const local = (yield* records()).map(located)
    return [...local, ...BUILT_IN_LIST]
  })

  const findRecord = Effect.fn("Skills.findRecord")(function* (
    name: string,
    operation: SkillOperation
  ) {
    for (const root of readable) {
      if (root !== primary) {
        const shared = (yield* listRoot(root, false, reported)).find(
          (record) => record.skill.name === name
        )
        if (shared !== undefined) return shared
        continue
      }
      const record = yield* loadRecord(root, name, operation).pipe(
        Effect.catch((error) =>
          error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error)
        )
      )
      if (record !== null) return record
    }
    return yield* skillError(operation, "not_found", `Skill ${name} was not found`)
  })

  const load = Effect.fn("Skills.load")(function* (name: string) {
    const builtin = builtInSkillByName(name)
    if (builtin !== undefined) return builtInLoaded(builtin)
    const record = yield* findRecord(name, "content")
    return {
      name: record.skill.name,
      description: record.skill.description,
      version: record.skill.version,
      content: record.content,
      directory: record.directory,
      builtin: false,
      enabled: record.skill.enabled
    } satisfies SkillLoadedContent
  })

  const content = (name: string): Effect.Effect<SkillContent, SkillError> =>
    load(name).pipe(
      Effect.map((loaded) => ({
        name: loaded.name,
        description: loaded.description,
        version: loaded.version,
        content: loaded.content
      }))
    )

  const create = Effect.fn("Skills.create")(function* (input: SkillCreateInput) {
    if (primary === null) return yield* storageUnavailable("create")
    yield* requireDirectory(primary, "create")
    const name = yield* Schema.decodeUnknownEffect(SkillNameSchema)(input.name).pipe(
      Effect.mapError((cause) => skillError("create", "invalid", "Skill name is invalid", cause))
    )
    if (isBuiltInSkillName(name)) return yield* reservedName("create", name)
    const description = yield* Schema.decodeUnknownEffect(SkillDescriptionSchema)(
      input.description.trim()
    ).pipe(
      Effect.mapError((cause) =>
        skillError("create", "invalid", "Skill description is invalid", cause)
      )
    )
    const version = yield* Schema.decodeUnknownEffect(SkillVersionSchema)(
      input.version ?? "1.0.0"
    ).pipe(
      Effect.mapError((cause) => skillError("create", "invalid", "Skill version is invalid", cause))
    )
    const body = input.body.trim()
    if (body === "") return yield* skillError("create", "invalid", "Skill body is required")
    const files = yield* Schema.decodeUnknownEffect(SkillResourceFilesSchema)(
      input.files ?? []
    ).pipe(
      Effect.mapError((cause) => skillError("create", "invalid", "Skill files are invalid", cause))
    )
    const skillContent = `---\n${stringify({ name, description, version }, { lineWidth: 0 }).trimEnd()}\n---\n\n${body}\n`
    if (new TextEncoder().encode(skillContent).byteLength > MAX_SKILL_BYTES) {
      return yield* skillError("create", "invalid", "Skill content is too large")
    }

    const target = join(primary, name)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(target, { mode: 0o700 })
        try {
          for (const file of files) {
            const destination = join(target, ...file.path.split("/"))
            await mkdir(dirname(destination), { recursive: true })
            await writeFile(destination, file.content, {
              flag: "wx",
              mode: file.executable ? 0o700 : 0o600
            })
          }
          await writeFile(join(target, SKILL_FILE), skillContent, { flag: "wx", mode: 0o600 })
        } catch (cause) {
          await rm(target, { recursive: true, force: true }).catch(() => undefined)
          throw cause
        }
      },
      catch: (cause) => {
        const exists =
          Predicate.hasProperty(cause, "code") &&
          Predicate.isString(cause.code) &&
          (cause.code === "EEXIST" || cause.code === "ENOTEMPTY")
        return skillError(
          "create",
          exists ? "invalid" : "storage",
          exists ? `Skill ${name} already exists` : "Skill could not be created",
          cause
        )
      }
    })
    return located(yield* loadRecord(primary, name, "create"))
  })

  const setEnabled = Effect.fn("Skills.setEnabled")(function* (name: string, enabled: boolean) {
    if (isBuiltInSkillName(name)) return yield* builtInUnchangeable("set_enabled", name)
    const record = yield* findRecord(name, "set_enabled")
    if (record.skill.enabled === enabled) return { name, enabled } satisfies SkillToggleReceipt
    const marker = join(record.directory, DISABLED_FILE)
    if (enabled) {
      yield* storage("set_enabled", "Skill state could not be changed", () => unlink(marker))
    } else {
      yield* storage("set_enabled", "Skill state could not be changed", () =>
        writeFile(marker, "", {
          flag: "wx"
        })
      )
    }
    return { name, enabled } satisfies SkillToggleReceipt
  })

  const remove = Effect.fn("Skills.remove")(function* (name: string) {
    if (isBuiltInSkillName(name)) return yield* builtInUnchangeable("remove", name)
    const record = yield* findRecord(name, "remove")
    if (record.root !== primary) {
      return yield* skillError(
        "remove",
        "invalid",
        `Skill ${name} lives in ${record.root}, which Arden shares with other agents; remove it there`
      )
    }
    yield* storage("remove", "Skill could not be removed", () =>
      rm(record.directory, {
        recursive: true,
        force: false,
        maxRetries: 2
      })
    )
    return { name, status: "removed" } satisfies SkillRemoveReceipt
  })

  return SkillCatalog.of({
    list,
    marketplacePopular: () =>
      list().pipe(
        Effect.flatMap((installed) =>
          marketplace.popular(new Set(installed.map((skill) => skill.name)))
        )
      ),
    marketplaceSearch: (query) =>
      list().pipe(
        Effect.flatMap((installed) =>
          marketplace.search(query, new Set(installed.map((skill) => skill.name)))
        )
      ),
    installMarketplace: (id) => {
      const name = splitMarketplaceSkillId(id)?.name ?? id
      if (isBuiltInSkillName(name)) return Effect.fail(reservedName("install", name))
      if (primary === null) return Effect.fail(storageUnavailable("install"))
      return requireDirectory(primary, "install").pipe(
        Effect.flatMap(() => marketplace.install(primary, id))
      )
    },
    content,
    load,
    reference: (name, resource) =>
      load(name).pipe(
        Effect.flatMap((loaded) => {
          if (!loaded.enabled)
            return Effect.fail(skillError("content", "not_found", "Skill is not enabled"))
          const directory = loaded.directory ?? authoredSkillDirectory(loaded.name)
          return readSkillReference(directory, resource)
        })
      ),
    create,
    update: (input) =>
      load(input.name).pipe(
        Effect.flatMap((loaded) => updateSkillInstructions(loaded, input)),
        Effect.flatMap(() => load(input.name)),
        Effect.flatMap((loaded) => {
          if (input.resource === undefined) return Effect.succeed(loaded)
          if (loaded.directory === null)
            return Effect.fail(builtInUnchangeable("update", loaded.name))
          return readSkillReference(loaded.directory, input.resource).pipe(
            Effect.map((content) => ({ ...loaded, content }))
          )
        })
      ),
    setEnabled,
    remove,
    promptCatalog: (options = {}) =>
      list().pipe(Effect.map((skills) => compactCatalog(skills, options)))
  })
})

export class SkillCatalog extends Context.Service<
  SkillCatalog,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<Skill>, SkillError>
    readonly marketplacePopular: () => Effect.Effect<ReadonlyArray<MarketplaceSkill>, SkillError>
    readonly marketplaceSearch: (
      query: string
    ) => Effect.Effect<ReadonlyArray<MarketplaceSkill>, SkillError>
    readonly installMarketplace: (id: string) => Effect.Effect<SkillInstallReceipt, SkillError>
    readonly content: (name: string) => Effect.Effect<SkillContent, SkillError>
    readonly load: (name: string) => Effect.Effect<SkillLoadedContent, SkillError>
    readonly update: (input: SkillUpdateInput) => Effect.Effect<SkillLoadedContent, SkillError>
    readonly reference: (name: string, resource: string) => Effect.Effect<string, SkillError>
    readonly create: (input: SkillCreateInput) => Effect.Effect<Skill, SkillError>
    readonly setEnabled: (
      name: string,
      enabled: boolean
    ) => Effect.Effect<SkillToggleReceipt, SkillError>
    readonly remove: (name: string) => Effect.Effect<SkillRemoveReceipt, SkillError>
    readonly promptCatalog: (
      options?: SkillCatalogPromptOptions
    ) => Effect.Effect<string | undefined, SkillError>
  }
>()("@arden-hq/server/skills/SkillCatalog") {}

export interface SkillCatalogLayerOptions {
  readonly extraRoots?: ReadonlyArray<string>
  readonly marketplace?: SkillMarketplaceOptions
}

export const skillCatalogLayer = (
  root: string | null,
  options: SkillCatalogLayerOptions = {}
): Layer.Layer<SkillCatalog, SkillError> =>
  Layer.effect(
    SkillCatalog,
    make(
      { primary: root, extra: options.extraRoots ?? [] },
      makeSkillMarketplace(options.marketplace)
    )
  )
