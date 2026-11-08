import { formatBytes } from "@arden-hq/std/count"
import { Effect } from "effect"
import { join } from "node:path"

import { atomicCompareAndSwap } from "../storage/local-paths.js"
import { skillError } from "./errors.js"
import { MAX_REFERENCE_BYTES, readSkillReference } from "./resources.js"
import { parseSkillMetadata } from "./metadata.js"
import type { SkillLoadedContent } from "./service.js"

export interface SkillUpdateInput {
  readonly name: string
  readonly expected_sha256: string
  readonly resource?: string
  readonly content: string
}

export const updateSkillInstructions = Effect.fn("Skills.updateInstructions")(function* (
  loaded: SkillLoadedContent,
  input: SkillUpdateInput
) {
  if (loaded.builtin || loaded.directory === null) {
    return yield* skillError("update", "invalid", "Built-in Skills cannot be updated")
  }
  if (new TextEncoder().encode(input.content).byteLength > 512 * 1024) {
    return yield* skillError("update", "invalid", "Skill content is too large")
  }
  if (input.resource === undefined) {
    yield* parseSkillMetadata(input.content, loaded.name, "update")
  } else {
    yield* readSkillReference(loaded.directory, input.resource)
    if (new TextEncoder().encode(input.content).byteLength > MAX_REFERENCE_BYTES) {
      return yield* skillError(
        "update",
        "invalid",
        `Skill reference exceeds ${formatBytes(MAX_REFERENCE_BYTES)}`
      )
    }
  }
  const target = join(loaded.directory, input.resource ?? "SKILL.md")
  return yield* Effect.tryPromise({
    try: () => atomicCompareAndSwap(target, input.content, input.expected_sha256),
    catch: (cause) =>
      skillError(
        "update",
        "invalid",
        "Skill changed or could not be updated; reload it before retrying",
        cause
      )
  })
})
