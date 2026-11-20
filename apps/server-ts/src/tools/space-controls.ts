import { boundary } from "../execution/decide.js"
import { refusalError } from "./refusal.js"
import type { ToolContext } from "@arden-hq/loop"
import { UpdateSpaceInputSchema } from "@arden-hq/protocol/effect/spaces"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { SpaceStore, type PersistedSpace } from "../persistence/spaces/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { runMayAct } from "../persistence/runs/liveness.js"
import { WorkStore } from "../persistence/work/store.js"
import { Wiki } from "../wiki/service.js"
import { createSpaceWithPage } from "../wiki/space-page.js"
import type { ServerRunContext } from "./run-context.js"
import { recordApplied } from "../execution/tool-effect.js"
import { toolFailure, toolRefusal } from "./tool-failure.js"

interface Services {
  readonly spaces: SpaceStore["Service"]
  readonly runs: RunQueries["Service"]
  readonly work: WorkStore["Service"]
}

const patchSchema = UpdateSpaceInputSchema.mapFields((fields) => ({
  name: fields.name.pipe(
    Schema.annotateEncoded({
      description: "New readable Space name; omit to keep the current name."
    })
  ),
  instructions: fields.instructions.annotate({
    description:
      "Complete replacement of the Space instructions, or null to clear them. Start from the current instructions space_list shows and keep every part the user did not ask to change."
  })
})).annotate({
  description: "Only changed settings; preserve settings the user did not ask to change."
})

const PREVIEW = "Space control not applied"
const failure = (error: Parameters<typeof toolFailure>[0]) => toolFailure(error, PREVIEW)
const refusal = (message: string) => toolRefusal(message, PREVIEW)
const publicSpace = ({ page_id: _pageId, ...space }: PersistedSpace) => space

export const requireChat = async (
  services: Pick<Services, "runs">,
  ctx: ToolContext<ServerRunContext>
) => {
  const [run, liveness] = await Effect.runPromise(
    Effect.all([services.runs.get(ctx.run.runId), services.runs.liveness(ctx.run.runId)]).pipe(
      Effect.mapError((cause) => failure(cause))
    ),
    { signal: ctx.signal }
  )
  if (!run || run.sessionId !== ctx.run.sessionId || liveness === undefined || !runMayAct(liveness))
    throw refusal("This Chat's turn has ended or was stopped, and nothing it started still runs")
  const verdict = boundary(ctx.run.authority, { kind: "space_control" })
  if (verdict.kind !== "allow")
    throw refusalError({
      what: "Only the user's own turn changes standing Space settings or Undoes a Task",
      rule: "boundary",
      instead: verdict.kind === "deny" ? verdict.instead : []
    })
}

const readCurrent = async (
  services: Services,
  spaceId: string,
  expected: string,
  ctx: ToolContext<ServerRunContext>
) => {
  await requireChat(services, ctx)
  const space = await Effect.runPromise(
    services.spaces.get(spaceId).pipe(Effect.mapError((cause) => failure(cause))),
    { signal: ctx.signal }
  )
  if (!space || space.updated_at !== expected)
    throw failure({
      reason: "conflict",
      message:
        "Space settings changed or are unavailable. Call space_list, reread the current instructions and rebuild the update from its current updated_at"
    })
  return space
}

const makeSpaceControlTools = (services: Services): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "space_settings_update",
    summary: "Changes a Space’s settings.",
    discovery: { group: "space" },
    description:
      "Rename a Space or replace its instructions, when the user asks, from their own chat. Read the current instructions with space_list first (pass space_id when they are cut off) and pass its exact updated_at. Returns the saved Space. Folders Arden may use or change are rules: offer one with ask_user permission. Workers cannot change these settings.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        space_id: Schema.NonEmptyString.annotate({
          description: "Exact Space id from space_list."
        }),
        expected_updated_at: Schema.NonEmptyString.annotate({
          description:
            "Exact updated_at of the Space settings just read; stale updates are refused."
        }),
        patch: patchSchema
      })
    ),
    metadata: {
      effect: "arden_db",
      display_name: "Update Space settings",
      kind: "tool",
      action: "write",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      destructive: false,
      concurrency_group: "space_work",
      approval_preview: "Review changes to standing Space settings."
    },
    execute: async (input, ctx, effects) => {
      await readCurrent(services, input.space_id, input.expected_updated_at, ctx)
      const space = await recordApplied(
        effects,
        Effect.runPromise(
          services.spaces
            .update(
              input.space_id,
              { ...input.patch, expected_updated_at: input.expected_updated_at },
              ctx.run.runId,
              ctx.toolCallId
            )
            .pipe(Effect.mapError((cause) => failure(cause))),
          { signal: ctx.signal }
        )
      )
      if (!space) throw refusal("The Space is no longer available")
      return {
        result: JSON.stringify(publicSpace(space)),
        preview: `${space.name} settings updated`,
        data: { space: publicSpace(space) }
      }
    }
  })
]

const spacePageHome = Schema.optionalKey(
  Schema.Literals(["projects", "areas"]).annotate({
    description:
      "Where the Space's Memory page goes: projects for a finite outcome; areas for ongoing responsibility or general Space context (default)."
  })
)

const makeSpaceSetupTools = (
  services: Pick<Services, "spaces" | "runs"> & {
    readonly wiki: Wiki["Service"]
  }
): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "space_create",
    summary: "Creates a new Space.",
    discovery: { group: "space" },
    description:
      "Create a Space explicitly requested by the user. Check space_list first to avoid duplicates. Folders Arden may use or change are rules: offer one with ask_user permission when the user asks. Do not ask for folders first: a file write elsewhere offers to keep its folder as a rule on its card. Ordinary Chat only.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        name: Schema.NonEmptyString.annotate({
          description: "Readable name for the Space requested by the user."
        }),
        home: spacePageHome
      })
    ),
    metadata: {
      effect: "arden_db",
      display_name: "Create Space",
      kind: "tool",
      action: "write",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      destructive: false,
      concurrency_group: "space_work"
    },
    execute: async (input, ctx, effects) => {
      await requireChat(services, ctx)
      const space = await recordApplied(
        effects,
        Effect.runPromise(
          createSpaceWithPage(
            services,
            { name: input.name },
            {
              mutation: { runId: ctx.run.runId, toolCallId: ctx.toolCallId },
              ...(input.home === undefined ? {} : { home: input.home })
            }
          ).pipe(Effect.mapError((cause) => failure(cause))),
          { signal: ctx.signal }
        )
      )
      return {
        result: JSON.stringify(publicSpace(space)),
        preview: `${space.name} created`,
        data: { space: publicSpace(space) }
      }
    }
  })
]

export const spaceControlTools = Effect.gen(function* () {
  const spaces = yield* SpaceStore
  const runs = yield* RunQueries
  return [
    ...makeSpaceSetupTools({ spaces, runs, wiki: yield* Wiki }),
    ...makeSpaceControlTools({ spaces, runs, work: yield* WorkStore })
  ]
})
