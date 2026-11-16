import { Effect, Layer } from "effect"
import { readFile, rm } from "node:fs/promises"
import { dirname } from "node:path"

import { isErrnoCode } from "../fs/private-store.js"
import { PROMPT_CATALOG } from "../prompts/catalog.js"
import { baseSystemPrompt } from "../models/instructions.js"
import { joinPromptSections, renderPromptSection } from "../prompts/format.js"
import { isRulesPage } from "../wiki/code-owned-pages.js"
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
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file))
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return undefined
    throw cause
  }
}

/**
 * Moves the rules file at the data root into Memory as the rules page, once: the page is made
 * only while Memory has none, and the file is removed after. A file left behind that holds what
 * the page holds is removed at the next start. A file that cannot be read stays, and runs are told.
 */
export const rulesMoveLayer = (file: string): Layer.Layer<never, never, Wiki> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const wiki = yield* Wiki
      const page = rulesPage(yield* wiki.snapshot())
      const content = yield* Effect.tryPromise(() => readRulesFile(file))
      if (page === undefined) yield* wiki.createRulesPage(content ?? "")
      else if (page.page.body !== content) return
      if (content !== undefined) yield* Effect.tryPromise(() => rm(file))
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("The standing rules could not be moved into Memory", { cause })
      )
    )
  )

/**
 * The rules a run is sent: the rules page. Every start makes it, so a run finds none only when the
 * start could not move the rules file into Memory; that is `failed`, as is a Memory it cannot read.
 */
export type GlobalInstructionsLoad =
  | { readonly kind: "read"; readonly page: PageRecord }
  | { readonly kind: "failed" }

export const loadForRun = (wiki: Wiki["Service"]): Effect.Effect<GlobalInstructionsLoad> =>
  wiki.snapshot().pipe(
    Effect.map(rulesPage),
    Effect.flatMap((page) =>
      page === undefined
        ? Effect.fail("The rules file was not moved into Memory")
        : Effect.succeed({ kind: "read", page } as const)
    ),
    Effect.catch((error) =>
      Effect.as(Effect.logWarning("Running without the global instructions", { error }), {
        kind: "failed"
      } as const)
    )
  )

const rulesText = (load: GlobalInstructionsLoad): string | undefined => {
  if (load.kind === "failed") return undefined
  const rules = load.page.page.body.trim()
  return rules === "" ? undefined : rules
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
