import type { Skill } from "@arden-hq/protocol/skills"
import { SKILL_PLACE } from "@arden-hq/protocol/skills"
import { SkillNameSchema } from "@arden-hq/protocol/effect/skills"
import { Effect, Schema } from "effect"
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises"
import { join } from "node:path"

import { BUILT_IN_SKILLS, isBuiltInSkillName } from "./builtin.js"
import { SKILL_ERROR_REASON, SkillError, skillError, type SkillOperation } from "./errors.js"
import { ERRNO, isErrnoCode } from "@arden-hq/std/errors"
import { declaredVersion, parseSkillMetadata } from "./metadata.js"
import { countOf } from "@arden-hq/std/count"
import { renderPromptSection } from "../prompts/format.js"
import {
  SKILL_FILE,
  DISABLED_FILE,
  MAX_SKILL_BYTES,
  MAX_CATALOG_CHARS,
  type SkillRecord,
  type SkillCatalogPromptOptions
} from "./skill-schemas.js"

export const storage = <A>(
  operation: SkillOperation,
  message: string,
  run: () => Promise<A>
): Effect.Effect<A, SkillError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const notFound = isErrnoCode(cause, ERRNO.ENOENT)
      return skillError(
        operation,
        notFound ? SKILL_ERROR_REASON.not_found : SKILL_ERROR_REASON.storage,
        message,
        cause
      )
    }
  })

export const requireDirectory = Effect.fn("Skills.requireDirectory")(function* (
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
      error.reason === SKILL_ERROR_REASON.not_found ? Effect.succeed(false) : Effect.fail(error)
    )
  )

export const loadRecord = Effect.fn("Skills.loadRecord")(function* (
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
      version: declaredVersion(metadata.version),
      enabled: !(yield* disabled(directory, operation))
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

export const compactCatalog = (
  skills: ReadonlyArray<Skill>,
  options: SkillCatalogPromptOptions
): string | undefined => {
  const omit = options.omit ?? new Set<string>()
  const builtins = BUILT_IN_SKILLS.filter((skill) => !omit.has(skill.name))
  const local = skills.filter(
    (skill) => skill.place.kind === SKILL_PLACE.local && skill.enabled && !omit.has(skill.name)
  )
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

export const storageUnavailable = (operation: SkillOperation): SkillError =>
  skillError(operation, "storage", "Skills storage is unavailable")

export const listRoot = Effect.fn("Skills.listRoot")(function* (
  root: string,
  folderIsName: boolean,
  reported: Set<string>
) {
  const entries = yield* storage("list", "Skills storage is unavailable", () =>
    readdir(root, { withFileTypes: true })
  ).pipe(
    Effect.catch((error) =>
      error.reason === SKILL_ERROR_REASON.not_found ? Effect.succeed([]) : Effect.fail(error)
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
