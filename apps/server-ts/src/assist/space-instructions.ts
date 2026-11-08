import type { SpaceTask } from "@arden-hq/protocol/spaces/work"
import { Effect } from "effect"

import type { StructuredCompletion } from "../models/structured-completion.js"
import type { SpaceStore } from "../persistence/spaces/store.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import type { Wiki } from "../wiki/service.js"

const TASK_LIMIT = 40
const PAGE_CONTENT_LIMIT = 8_000

export interface SpaceInstructionsDependencies {
  readonly completion: StructuredCompletion["Service"]
  readonly store: SpaceStore["Service"]
  readonly wiki: Wiki["Service"]
}

export const makeSpaceInstructions = (dependencies: SpaceInstructionsDependencies) =>
  Effect.fn("SpaceInstructions.generate")(function* (spaceId: string) {
    const space = yield* dependencies.store.get(spaceId)
    if (space === null) return undefined
    if (space.instructions_source === "manual" && space.instructions !== null) return space
    const page =
      space.page_id === null
        ? null
        : yield* dependencies.wiki
            .read(space.page_id)
            .pipe(Effect.catchTag("WikiError", () => Effect.succeed(null)))
    const detail = yield* dependencies.store.detail(spaceId)
    const instructions = yield* dependencies.completion.runText({
      role: "helper",
      usage: { kind: "space_instructions", owner: { type: "space", spaceId } },
      system: PROMPT_TEXT.spaceInstructions,
      user: spaceBrief(
        space.name,
        space.page_path,
        page === null ? null : page.content,
        detail === null ? [] : detail.work.work_items
      ),
      maxOutputTokens: 2_048,
      maxCharacters: 4_000
    })
    return (yield* dependencies.store.setGeneratedInstructions(spaceId, instructions)) ?? undefined
  })

const spaceBrief = (
  name: string,
  pagePath: string | null,
  pageContent: string | null,
  tasks: ReadonlyArray<SpaceTask>
): string => {
  const live = tasks.filter((task) => task.status === "open")
  return JSON.stringify({
    space_name: name,
    memory_page: pagePath,
    memory_page_content: pageContent?.slice(0, PAGE_CONTENT_LIMIT) ?? null,
    live_tasks: live.slice(0, TASK_LIMIT).map((task) => ({
      stable_key: task.stable_key,
      status: task.status,
      owner: task.owner,
      text: task.text
    }))
  })
}
