import { quoted } from "@arden-hq/std/count"
import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { requireChat } from "./space-controls.js"
import { SpaceStore, type PersistedSpace } from "../persistence/spaces/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import type { ServerRunContext } from "./run-context.js"
import { recordApplied } from "../execution/tool-effect.js"

interface Services {
  readonly spaces: SpaceStore["Service"]
  readonly runs: RunQueries["Service"]
}

const RESTORE_LINE = "Nothing is deleted: restore it any time from Settings → Archive."

const refuse = (message: string) =>
  new ToolExecutionError(message, { preview: "Space not archived", retryable: false })

const isArchiveApproval = Schema.is(Schema.Struct({ space_id: Schema.String }))

const isOwnSpace = (ctx: ToolContext<ServerRunContext>, spaceId: string) =>
  ctx.run.policy.space?.space_id === spaceId

const archivableSpace = async (
  services: Services,
  input: { readonly space_id: string },
  ctx: ToolContext<ServerRunContext>
): Promise<PersistedSpace> => {
  await requireChat(services, ctx)
  const space = await Effect.runPromise(
    services.spaces
      .get(input.space_id, true)
      .pipe(Effect.mapError((cause) => refuse(cause.message))),
    { signal: ctx.signal }
  )
  if (space === null)
    throw refuse(`No Space has id ${input.space_id}. Call space_list for the current Space ids.`)
  if (space.archived_at !== null)
    throw refuse(
      `${quoted(space.name)} is already archived. The user can restore it from Settings → Archive.`
    )
  if (isOwnSpace(ctx, space.space_id))
    throw refuse(
      `This chat is on ${quoted(space.name)}, and archiving a Space archives its chats. The user can archive it from the sidebar, or ask in a chat on another Space or Home.`
    )
  return space
}

const makeSpaceArchiveTool = (services: Services): ServerTool =>
  defineServerTool({
    name: "space_archive",
    description: [
      "Archive a Space the user asked to put away, by exact space_id from space_list.",
      "Archiving hides the Space and its chats and stops its standing work; nothing is deleted, and the user can restore it from Settings → Archive.",
      "Every call asks the user on a card. Unknown or already archived Spaces are refused.",
      "The Space this chat is on is refused. Ordinary Chat only."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        space_id: Schema.NonEmptyString.annotate({
          description: "Exact Space id from space_list; never its display name."
        })
      })
    ),
    metadata: {
      effect: "arden_db",
      display_name: "Archive Space",
      kind: "tool",
      action: "write",
      approval_preview: "Archive a Space.",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      destructive: false,
      idempotent: false,
      concurrency_group: "space_work",
      default_approval: "ask",
      always_ask: true,
      code_mode: false
    },
    approvalPrompt: async (input, ctx) => {
      const space = await archivableSpace(services, input, ctx)
      return {
        preview: `Archive ${space.name}`,
        presentation: {
          title: `Archive ${quoted(space.name)}?`,
          fields: [{ label: "Space", value: space.name }],
          note: RESTORE_LINE,
          approve_label: "Archive"
        },
        data: { space_id: space.space_id }
      }
    },
    execute: async (input, ctx, effects) => {
      const approved = ctx.approval?.data
      if (!isArchiveApproval(approved) || approved.space_id !== input.space_id)
        throw refuse("A Space is archived only after the user approves its card.")
      const space = await archivableSpace(services, input, ctx)
      const archived = await recordApplied(
        effects,
        Effect.runPromise(
          services.spaces
            .archive(space.space_id, { runId: ctx.run.runId, toolCallId: ctx.toolCallId })
            .pipe(
              Effect.mapError((cause) =>
                refuse(
                  cause.reason === "conflict"
                    ? `${cause.message}, so ${quoted(space.name)} was not archived. The user can archive it from its menu, which asks before stopping that work, or after the work finishes.`
                    : cause.message
                )
              )
            ),
          { signal: ctx.signal }
        )
      )
      if (archived === null)
        throw refuse(`${quoted(space.name)} changed while waiting and was not archived.`)
      return {
        result: `Archived ${quoted(space.name)}. ${RESTORE_LINE}`,
        preview: `${space.name} archived`,
        data: { space_id: space.space_id, name: space.name }
      }
    }
  })

export const spaceArchiveTools = Effect.gen(function* () {
  return [makeSpaceArchiveTool({ spaces: yield* SpaceStore, runs: yield* RunQueries })]
})
