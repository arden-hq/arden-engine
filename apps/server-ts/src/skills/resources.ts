import { formatBytes } from "@arden-hq/std/count"
import { Effect, Schema } from "effect"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { skillError } from "./errors.js"

export const MAX_REFERENCE_BYTES = 128 * 1024

const SkillReferencePathSchema = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter((value) =>
    value.startsWith("references/") &&
    value.endsWith(".md") &&
    !/[\\\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
      ? undefined
      : "must be a relative Markdown path under references/"
  )
)

export const readSkillReference = Effect.fn("Skills.readReference")(function* (
  directory: string,
  resource: string
) {
  const safe = yield* Schema.decodeUnknownEffect(SkillReferencePathSchema)(resource).pipe(
    Effect.mapError((cause) =>
      skillError("content", "invalid", "Use a Markdown path under references/", cause)
    )
  )
  return yield* Effect.tryPromise({
    try: async () => {
      const target = join(directory, ...safe.split("/"))
      const status = await stat(target)
      if (!status.isFile() || status.size > MAX_REFERENCE_BYTES) {
        throw new Error(
          `Skill references must be Markdown files no larger than ${formatBytes(MAX_REFERENCE_BYTES)}; split larger references`
        )
      }
      const bytes = await readFile(target)
      if (bytes.byteLength > MAX_REFERENCE_BYTES)
        throw new Error(`Skill reference exceeds ${formatBytes(MAX_REFERENCE_BYTES)}`)
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    },
    catch: (cause) =>
      skillError("content", "invalid", "Skill reference is unavailable or invalid", cause)
  })
})
