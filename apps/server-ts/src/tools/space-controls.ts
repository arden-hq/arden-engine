import { boundary } from "../execution/decide.js"
import { refusalError } from "./refusal.js"
import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { UpdateSpaceInputSchema } from "@arden-hq/protocol/effect/spaces"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { SpaceStore, type PersistedSpace } from "../persistence/spaces/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { runMayAct } from "../persistence/runs/liveness.js"
import { WorkStore } from "../persistence/work/store.js"
import { Wiki } from "../wiki/service.js"
import type { ServerRunContext } from "./run-context.js"
import { recordApplied } from "../execution/tool-effect.js"
import { pageReceipt } from "./wiki-records.js"
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
    description: "Complete replacement of the Space instructions, or null to clear them."
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
        "Space settings changed or are unavailable. Call space_list and rebuild the update from its current updated_at"
    })
  return space
}

const makeSpaceControlTools = (services: Services): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "space_settings_update",
    description:
      "Change Space settings requested by the user from ordinary Chat. Read space_list first and pass its exact updated_at. Echo the saved settings. Folders Arden may use or change are rules: offer one with ask_user permission. Workers cannot change these settings.",
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

const makeSpaceSetupTools = (
  services: Pick<Services, "spaces" | "runs"> & {
    readonly wiki: Wiki["Service"]
  }
): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "space_create",
    description:
      "Create a Space explicitly requested by the user. Check space_list first to avoid duplicates. Folders Arden may use or change are rules: offer one with ask_user permission when the user asks. Do not ask for folders first: a file write elsewhere offers to keep its folder as a rule on its card. Ordinary Chat only.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        name: Schema.NonEmptyString.annotate({
          description: "Readable name for the Space requested by the user."
        })
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
          services.spaces
            .create({ name: input.name }, { runId: ctx.run.runId, toolCallId: ctx.toolCallId })
            .pipe(Effect.mapError((cause) => failure(cause))),
          { signal: ctx.signal }
        )
      )
      return {
        result: JSON.stringify(publicSpace(space)),
        preview: `${space.name} created`,
        data: { space: publicSpace(space) }
      }
    }
  }),
  defineServerTool({
    name: "space_page_create",
    description:
      "Create and attach a Space's Memory page at the user's request. Choose projects for a finite outcome, areas for ongoing responsibilities; the default is ongoing Space context in areas. Returns the existing page if already attached. Use space_page_write afterward to add context. Ordinary Chat only.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        space_id: Schema.NonEmptyString.annotate({
          description: "Exact Space identity returned by space_list; never its display name."
        }),
        home: Schema.optionalKey(
          Schema.Literals(["projects", "areas"]).annotate({
            description:
              "projects for a finite outcome; areas for ongoing responsibility or general Space context (default)."
          })
        )
      })
    ),
    metadata: {
      effect: "arden_db",
      display_name: "Create Space Memory",
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
      const { space, page } = await Effect.runPromise(
        Effect.gen(function* () {
          const current = yield* services.spaces.get(input.space_id)
          if (!current) return yield* Effect.fail(refusal("Space is unavailable"))
          if (current.page_path !== null) {
            effects.unchanged()
            return { space: current, page: undefined }
          }
          const created = yield* services.wiki.createSpacePage({
            spaceId: current.space_id,
            title: current.name,
            home: input.home ?? "areas"
          })
          effects.applied()
          const bound = yield* services.spaces.bindPage(
            current.space_id,
            created.pageId,
            created.path
          )
          if (!bound) return yield* Effect.fail(refusal("Space is unavailable"))
          return { space: bound, page: created }
        }).pipe(
          Effect.mapError((cause) => (cause instanceof ToolExecutionError ? cause : failure(cause)))
        ),
        { signal: ctx.signal }
      )
      return {
        result: JSON.stringify(publicSpace(space)),
        preview: `${space.name} Memory ready`,
        data: { space: publicSpace(space) },
        ...(page === undefined ? {} : { host: pageReceipt({ ctx, page, beforeVersion: "absent" }) })
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
