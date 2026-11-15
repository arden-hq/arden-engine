import { Effect, Layer } from "effect"
import { lstat, readFile, rm } from "node:fs/promises"
import { dirname } from "node:path"

import { isErrnoCode } from "../fs/private-store.js"
import { PROMPT_CATALOG } from "../prompts/catalog.js"
import { baseSystemPrompt } from "../models/instructions.js"
import { joinPromptSections, renderPromptSection } from "../prompts/format.js"
import { isRulesPage } from "../wiki/code-owned-pages.js"
import type { WikiError } from "../wiki/errors.js"
import { Wiki } from "../wiki/service.js"
import type { PageRecord, Snapshot } from "../wiki/snapshot.js"
import {
  renderInstructionSource,
  type LocalInstructionManifestEntry
} from "./local-instructions.js"

export const rulesPage = (snapshot: Snapshot): PageRecord | undefined =>
  snapshot.wholeSet.find(
    (record) => isRulesPage(record.resource.path) && record.page.lifecycle === "active"
  )

const readRulesFile = async (file: string): Promise<string | undefined> => {
  try {
    if (!(await lstat(file)).isFile()) throw new Error(`${file} is not a regular file`)
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return undefined
    throw cause
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file))
}

/**
 * Moves the rules file at the data root into Memory as the rules page, once: the page is made
 * only while Memory has none, and the file is removed after.
 */
export const rulesMoveLayer = (file: string): Layer.Layer<never, never, Wiki> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const wiki = yield* Wiki
      if (rulesPage(yield* wiki.snapshot()) !== undefined) return
      const content = yield* Effect.tryPromise(() => readRulesFile(file))
      yield* wiki.createRulesPage(content ?? "")
      if (content !== undefined) yield* Effect.tryPromise(() => rm(file))
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("The standing rules could not be moved into Memory", { cause })
      )
    )
  )

export type GlobalInstructionsLoad =
  | { readonly kind: "read"; readonly page: PageRecord | undefined }
  | { readonly kind: "failed"; readonly error: WikiError }

export const loadForRun = (wiki: Wiki["Service"]): Effect.Effect<GlobalInstructionsLoad> =>
  wiki.snapshot().pipe(
    Effect.map((snapshot): GlobalInstructionsLoad => ({ kind: "read", page: rulesPage(snapshot) })),
    Effect.catch((error) =>
      Effect.as(Effect.logWarning("Running without the global instructions", { error }), {
        kind: "failed",
        error
      } satisfies GlobalInstructionsLoad)
    )
  )

const rulesText = (load: GlobalInstructionsLoad): string | undefined => {
  const body = load.kind === "read" ? load.page?.page.body.trim() : undefined
  return body === "" ? undefined : body
}

export const globalInstructionManifest = (
  file: string,
  load: GlobalInstructionsLoad
): ReadonlyArray<LocalInstructionManifestEntry> => {
  const entry = (
    status: LocalInstructionManifestEntry["status"],
    digest: string | null
  ): LocalInstructionManifestEntry => ({
    root: dirname(file),
    path: file,
    scope: dirname(file),
    status,
    digest
  })
  if (load.kind === "failed") return [entry("unreadable", null)]
  if (load.page === undefined) return []
  return rulesText(load) === undefined
    ? [entry("empty", null)]
    : [entry("loaded", load.page.resource.versionId)]
}

export const chatSystemPrompt = (
  assistantName: string,
  file: string,
  load: GlobalInstructionsLoad
): string => {
  const rules = rulesText(load)
  return (
    joinPromptSections([
      baseSystemPrompt(assistantName),
      rules === undefined
        ? undefined
        : renderPromptSection(
            "Global instructions",
            [
              PROMPT_CATALOG.globalInstructions.render({
                assistant_name: JSON.stringify(assistantName)
              }).text,
              renderInstructionSource(file, "loaded", rules)
            ].join("\n\n")
          )
    ]) ?? ""
  )
}
