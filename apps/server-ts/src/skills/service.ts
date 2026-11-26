import type {
  MarketplaceSkill,
  Skill,
  SkillContent,
  SkillInstallReceipt,
  SkillRemoveReceipt,
  SkillToggleReceipt
} from "@arden-hq/protocol/skills"
import {
  SkillDescriptionSchema,
  SkillNameSchema,
  SkillVersionSchema,
  splitMarketplaceSkillId
} from "@arden-hq/protocol/effect/skills"
import { Context, Effect, Layer, Predicate, Schema } from "effect"
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { authoredSkillDirectory } from "../prompts/catalog.js"

import { updateSkillInstructions, type SkillUpdateInput } from "./update.js"
import { readSkillReference } from "./resources.js"
import { stringify } from "yaml"

import {
  BUILT_IN_SKILLS,
  builtInSkillByName,
  builtInUnchangeable,
  isBuiltInSkillName,
  reservedName,
  type BuiltInSkill
} from "./builtin.js"
import { SkillError, skillError, type SkillOperation } from "./errors.js"
import {
  makeSkillMarketplace,
  type SkillMarketplaceOptions,
  type SkillMarketplaceSource
} from "./marketplace.js"
import { parseSkillMetadata } from "./metadata.js"
import { countOf } from "@arden-hq/std/count"
import { renderPromptSection } from "../prompts/format.js"

const SKILL_FILE = "SKILL.md"
const DISABLED_FILE = ".disabled"
const MAX_SKILL_BYTES = 512 * 1024
const MAX_CATALOG_CHARS = 32_000
const MAX_RESOURCE_FILES = 128
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024
const MAX_RESOURCES_BYTES = 10 * 1024 * 1024

const SkillResourcePathSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => {
    const parts = value.split("/")
    if (value.startsWith("/") || value.includes("\\") || parts.length > 8) {
      return "must be a shallow relative path"
    }
    if (/[\u0000-\u001f\u007f]/u.test(value)) return "must not contain control characters"
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      return "must not contain empty or traversing path components"
    }
    return ["scripts", "references", "assets"].includes(parts[0] ?? "") && parts.length > 1
      ? undefined
      : "must be inside scripts, references, or assets"
  })
)

const SkillResourceFileSchema = Schema.Struct({
  path: SkillResourcePathSchema,
  content: Schema.String.check(
    Schema.makeFilter((value) =>
      new TextEncoder().encode(value).byteLength <= MAX_RESOURCE_BYTES
        ? undefined
        : `must be at most ${MAX_RESOURCE_BYTES} bytes as UTF-8`
    )
  ),
  executable: Schema.Boolean
}).check(
  Schema.makeFilter((file) =>
    file.executable && !file.path.startsWith("scripts/")
      ? { path: ["executable"], issue: "may be true only for scripts" }
      : undefined
  )
)

const SkillResourceFilesSchema = Schema.Array(SkillResourceFileSchema).check(
  Schema.makeFilter((files) => {
    if (files.length > MAX_RESOURCE_FILES) {
      return `must contain at most ${MAX_RESOURCE_FILES} files`
    }
    const paths = new Set(files.map((file) => file.path))
    if (paths.size !== files.length) return "must not contain duplicate paths"
    const bytes = files.reduce(
      (total, file) => total + new TextEncoder().encode(file.content).byteLength,
      0
    )
    return bytes <= MAX_RESOURCES_BYTES
      ? undefined
      : `must total at most ${MAX_RESOURCES_BYTES} bytes as UTF-8`
  })
)

interface SkillRecord {
  readonly skill: Skill
  readonly content: string
  readonly directory: string
  readonly identity: string
  readonly root: string
}

export interface SkillRoots {
  readonly primary: string | null
  readonly extra: ReadonlyArray<string>
}

export interface SkillLoadedContent extends SkillContent {
  readonly directory: string | null
  readonly builtin: boolean
  readonly enabled: boolean
}

const builtInSkill = (skill: BuiltInSkill): Skill => ({
  name: skill.name,
  description: skill.description,
  version: skill.version,
  enabled: true,
  builtin: true,
  ...(skill.userInvocable ? { invocable: true as const } : {})
})

const builtInLoaded = (skill: BuiltInSkill): SkillLoadedContent => ({
  name: skill.name,
  description: skill.description,
  version: skill.version,
  content: skill.content,
  directory: null,
  builtin: true,
  enabled: true
})

const BUILT_IN_LIST: ReadonlyArray<Skill> = BUILT_IN_SKILLS.map(builtInSkill)

export interface SkillCatalogPromptOptions {
  readonly omit?: ReadonlySet<string>
}

export interface SkillCreateInput {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly version?: string
  readonly files?: ReadonlyArray<{
    readonly path: string
    readonly content: string
    readonly executable: boolean
  }>
}

const storage = <A>(
  operation: SkillOperation,
  message: string,
  run: () => Promise<A>
): Effect.Effect<A, SkillError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const notFound =
        Predicate.hasProperty(cause, "code") &&
        Predicate.isString(cause.code) &&
        cause.code === "ENOENT"
      return skillError(operation, notFound ? "not_found" : "storage", message, cause)
    }
  })

const requireDirectory = Effect.fn("Skills.requireDirectory")(function* (
  directory: string,
  operation: SkillOperation
) {
  const status = yield* storage(operation, "Skill directory is unavailable", () => stat(directory))
  if (!status.isDirectory()) {
    return yield* skillError(operation, "invalid", "Skill directory is invalid")
  }
})

const disabled = (
  directory: string,
  operation: SkillOperation
): Effect.Effect<boolean, SkillError> =>
  storage(operation, "Skill state is unavailable", () =>
    lstat(join(directory, DISABLED_FILE))
  ).pipe(
    Effect.flatMap((status) =>
      status.isFile() && !status.isSymbolicLink()
        ? Effect.succeed(true)
        : Effect.fail(skillError(operation, "invalid", "Skill state is invalid"))
    ),
    Effect.catch((error) =>
      error.reason === "not_found" ? Effect.succeed(false) : Effect.fail(error)
    )
  )

/**
 * Reads the Skill in one folder of a root. In Arden's own root the folder is
 * named after the Skill. A shared root is written by other tools, which name
 * the folder freely (`my-skill-1.2.0`), so there the name comes from SKILL.md.
 */
const loadRecord = Effect.fn("Skills.loadRecord")(function* (
  root: string,
  folder: string,
  operation: SkillOperation,
  folderIsName = true
) {
  yield* requireDirectory(root, operation)
  if (folderIsName) {
    yield* Schema.decodeUnknownEffect(SkillNameSchema)(folder).pipe(
      Effect.mapError((cause) => skillError(operation, "invalid", "Skill name is invalid", cause))
    )
  }
  const directory = join(root, folder)
  yield* requireDirectory(directory, operation)
  const identity = yield* storage(operation, "Skill directory is unavailable", () =>
    realpath(directory)
  )
  const filename = join(directory, SKILL_FILE)
  const status = yield* storage(operation, "Skill content is unavailable", () => stat(filename))
  if (!status.isFile() || status.size > MAX_SKILL_BYTES) {
    return yield* skillError(operation, "invalid", "Skill content is invalid")
  }
  const bytes = yield* storage(operation, "Skill content is unavailable", () => readFile(filename))
  const content = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) => skillError(operation, "invalid", "Skill content is not valid UTF-8", cause)
  })
  const metadata = yield* parseSkillMetadata(content, folderIsName ? folder : null, operation)
  const record: SkillRecord = {
    skill: {
      name: metadata.name,
      description: metadata.description,
      version: metadata.version ?? null,
      enabled: !(yield* disabled(directory, operation)),
      builtin: false
    },
    content,
    directory,
    identity,
    root
  }
  return record
})

const BUILT_IN_GUIDANCE = [
  "Built-in Skills are part of the system; each carries the rules for one tool group.",
  "Before the first call to a tool group listed below, load its Skill with the `skill` tool. Other tool groups have no Skill; call their tools directly.",
  "Load a Skill only when its instructions are absent from context; reload after compaction if needed. Read linked references with skill(name, resource) only when relevant.",
  "A Skill marked (/name) can also be called by the user: if a user message contains that exact `/name`, load the Skill before answering and do what it is for."
].join("\n")

const LOCAL_GUIDANCE = [
  "Local Skills are installed by the user.",
  "Load one with the `skill` tool only when its description clearly matches the request.",
  "Do not load one for a direct operation unless its instructions add something beyond the available tool contracts.",
  "If a user message starts with an exact `/name` from this list, load that Skill before answering.",
  "Keep the user's message unchanged."
].join("\n")

const compactCatalog = (
  skills: ReadonlyArray<Skill>,
  options: SkillCatalogPromptOptions
): string | undefined => {
  const omit = options.omit ?? new Set<string>()
  const builtins = BUILT_IN_SKILLS.filter((skill) => !omit.has(skill.name))
  const local = skills.filter((skill) => !skill.builtin && skill.enabled && !omit.has(skill.name))
  if (builtins.length === 0 && local.length === 0) return undefined
  const sections: Array<string> = []
  if (builtins.length > 0) {
    sections.push(
      [
        BUILT_IN_GUIDANCE,
        "",
        ...builtins.map(
          (skill) =>
            `- ${skill.name}${skill.userInvocable ? ` (/${skill.name})` : ""} (${skill.toolGroup}): ${JSON.stringify(skill.description)}`
        )
      ].join("\n")
    )
  }
  if (local.length > 0) sections.push(LOCAL_GUIDANCE)
  let output = renderPromptSection("Skills", sections.join("\n\n"))
  const lines = local.map((skill) => `- ${skill.name}: ${JSON.stringify(skill.description)}`)
  for (const [index, line] of lines.entries()) {
    const separator = index === 0 ? "\n\n" : "\n"
    if (output.length + line.length + separator.length > MAX_CATALOG_CHARS - 160) {
      output += `\n\n${lines.length - index} more local Skills omitted. Use skill_list to discover them, or load an exact known name directly.`
      break
    }
    output += `${separator}${line}`
  }
  return output
}

const storageUnavailable = (operation: SkillOperation): SkillError =>
  skillError(operation, "storage", "Skills storage is unavailable")

const listRoot = Effect.fn("Skills.listRoot")(function* (
  root: string,
  folderIsName: boolean,
  reported: Set<string>
) {
  const entries = yield* storage("list", "Skills storage is unavailable", () =>
    readdir(root, { withFileTypes: true })
  ).pipe(
    Effect.catch((error) =>
      error.reason === "not_found" ? Effect.succeed([]) : Effect.fail(error)
    )
  )
  const names = entries
    .filter(
      (entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        !entry.name.startsWith(".") &&
        !isBuiltInSkillName(entry.name)
    )
    .map((entry) => entry.name)
    .sort()
  const results = yield* Effect.forEach(
    names,
    (name) =>
      loadRecord(root, name, "list", folderIsName).pipe(
        Effect.map((record) => ({ record })),
        Effect.catch((error) => Effect.succeed({ skipped: `${name} (${error.message})` }))
      ),
    { concurrency: 8 }
  )
  const fresh = results.flatMap((result) =>
    "skipped" in result && !reported.has(`${root}/${result.skipped}`) ? [result.skipped] : []
  )
  for (const skipped of fresh) reported.add(`${root}/${skipped}`)
  if (fresh.length > 0)
    yield* Effect.logWarning(
      `Skipped ${countOf(fresh.length, "unreadable Skill")} in ${root}: ${fresh.join(", ")}`
    )
  return results.flatMap((result) => ("record" in result ? [result.record] : []))
})

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
    origin: record.root === primary ? "arden" : "shared",
    path: record.directory
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
    return (yield* loadRecord(primary, name, "create")).skill
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
