import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import type { SpaceDetail } from "@arden-hq/protocol/spaces"
import { taskActivityWords } from "@arden-hq/protocol/spaces/work"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import {
  SpaceStore,
  SpaceStoreError,
  spaceChoices,
  type PersistedSpace
} from "../persistence/spaces/store.js"
import { SessionQueries, type SessionQueryFailure } from "../persistence/sessions/queries.js"
import { WorkStore } from "../persistence/work/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { toolFailure } from "./tool-failure.js"
import { taskHandle } from "./task-handle.js"
import { writeIdentity } from "./wiki-identity.js"
import { formatWikiPage } from "../wiki/page.js"
import { Wiki } from "../wiki/service.js"
import type { PageRecord, Snapshot } from "../wiki/snapshot.js"
import type { ServerRunContext } from "./run-context.js"
import {
  MAX_WIKI_CONTENT_CHARS,
  boundedBody,
  loadSnapshot,
  pageData,
  wikiFailure,
  writtenPageData
} from "./wiki.js"
import { recordApplied } from "../execution/tool-effect.js"
import { pageReceipt, pageSource } from "./wiki-records.js"
import { workTarget } from "./work-reach.js"
import { refusalError } from "./refusal.js"

const MAX_PAGE_LINES = 4_000

const OptionalSpaceIdSchema = Schema.optionalKey(
  Schema.NonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description: "Exact space_id from space_list. Omit to use the current session's Space."
  })
)

const SpacePageReadParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .annotate({
      description: "One-based first body line to return. Defaults to 1."
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_LINES }))
    .annotate({
      description: `Maximum body lines to return, from 1 to ${MAX_PAGE_LINES}. Defaults to 500.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(500)))
})

const SpacePagePatchParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  old_text: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description: "Exact current body text to replace. It must occur exactly once."
  }),
  new_text: Schema.String.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description: "Literal replacement text. Empty removes the matched text."
  })
})

const SpacePageWriteParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  body: Schema.String.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description: "Complete replacement Markdown body. Page identity and metadata stay unchanged."
  })
})

interface SpaceToolServices {
  readonly spaces: SpaceStore["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
  readonly work: WorkStore["Service"]
  readonly wiki: Wiki["Service"]
}

interface SpaceTarget {
  readonly space: PersistedSpace
}

interface SpacePageTarget extends SpaceTarget {
  readonly snapshot: Snapshot
  readonly page: PageRecord
}

const sessionFailure = (cause: SessionQueryFailure): ToolExecutionError =>
  toolFailure(
    { reason: cause.reason, message: `Could not resolve the current Space: ${cause.message}` },
    "Space unavailable"
  )

const spaceFailure = (error: SpaceStoreError): ToolExecutionError =>
  error.reason === "conflict"
    ? new ToolExecutionError(error.message, { preview: "Space changed", retryable: false })
    : toolFailure(error, "Space unavailable")

export const noSpace = async (
  services: { readonly spaces: SpaceStore["Service"] },
  requestedSpaceId: string | undefined,
  signal: AbortSignal
): Promise<ToolExecutionError> => {
  const spaces = await Effect.runPromise(
    services.spaces.list().pipe(Effect.mapError(spaceFailure)),
    {
      signal
    }
  )
  return new ToolExecutionError(
    `${
      requestedSpaceId === undefined
        ? "This chat is in no Space, so name the Space."
        : `No active Space exists with id '${requestedSpaceId}'.`
    } ${spaceChoices(spaces)}`,
    {
      preview: requestedSpaceId === undefined ? "Space required" : "Space not found",
      retryable: false
    }
  )
}

const resolveSpace = async (
  services: SpaceToolServices,
  run: ServerRunContext,
  requestedSpaceId: string | undefined,
  signal: AbortSignal,
  options: { readonly mutation: boolean }
): Promise<SpaceTarget> => {
  const header = await Effect.runPromise(
    services.sessions.loadHistoryHeader(run.sessionId).pipe(Effect.mapError(sessionFailure)),
    { signal }
  )
  const spaceId = options.mutation
    ? mutationSpace(run, header?.spaceId ?? undefined, requestedSpaceId)
    : (requestedSpaceId ?? header?.spaceId ?? undefined)
  if (spaceId === undefined) throw await noSpace(services, undefined, signal)
  const space = await Effect.runPromise(
    services.spaces.get(spaceId).pipe(Effect.mapError(spaceFailure)),
    { signal }
  )
  if (space === null) throw await noSpace(services, spaceId, signal)
  return { space }
}

const mutationSpace = (
  run: ServerRunContext,
  chatSpaceId: string | undefined,
  requestedSpaceId: string | undefined
): string | undefined => {
  const decision = workTarget({
    authority: run.authority,
    chatSpaceId,
    chatSessionId: run.sessionId,
    requestedSpaceId,
    op: "change"
  })
  if (decision.kind === "target") {
    switch (decision.target.kind) {
      case "space":
        return decision.target.spaceId
      case "job":
        return decision.target.spaceId ?? chatSpaceId
      case "chat":
        return undefined
    }
  }
  if (decision.reason === "no_space") return undefined
  throw refusalError({
    what: PAGE_REFUSAL[decision.reason],
    rule: "boundary",
    instead: decision.instead
  })
}

const PAGE_REFUSAL = {
  outside_job_space: "A job changes only its own Space's page",
  outside_delegated_space: "An agent changes only the page of the Space whose chat started it",
  unrecorded: "This run's authority was not recorded, so it cannot change a Space page"
} as const

const resolveSpacePage = async (
  services: SpaceToolServices,
  run: ServerRunContext,
  requestedSpaceId: string | undefined,
  signal: AbortSignal,
  options: { readonly mutation: boolean }
): Promise<SpacePageTarget> => {
  const target = await resolveSpace(services, run, requestedSpaceId, signal, options)
  if (target.space.page_id === null || target.space.page_path === null) {
    throw new ToolExecutionError(`Space '${target.space.name}' has no attached Wiki page.`, {
      preview: "No Space page",
      retryable: false
    })
  }
  const snapshot = await loadSnapshot(services.wiki, signal)
  const page = snapshot.pages.find(
    (record) => record.page.pageId === target.space.page_id && record.page.lifecycle === "active"
  )
  if (page === undefined) {
    throw new ToolExecutionError(
      `The Wiki page attached to Space '${target.space.name}' is missing.`,
      {
        preview: "Space page missing",
        retryable: false
      }
    )
  }
  return { ...target, snapshot, page }
}

const publicSpace = (space: PersistedSpace) => ({
  space_id: space.space_id,
  name: space.name,
  instructions: space.instructions,
  page_path: space.page_path,
  inference: space.inference,
  updated_at: space.updated_at
})

const requireObserved = (ctx: ServerRunContext, page: PageRecord): string => {
  const version = ctx.observations.observed(page.page.pageId)
  if (version !== undefined) return version
  throw new ToolExecutionError("Read the Space page before changing it, then retry.", {
    preview: "Read Space page first",
    retryable: false
  })
}

const updateSpacePage = async (
  services: SpaceToolServices,
  target: SpacePageTarget,
  body: string,
  ctx: ToolContext<ServerRunContext>,
  reason: string
) => {
  if (target.snapshot.head === null) {
    throw new ToolExecutionError("The attached Space page has no Wiki repository revision.", {
      preview: "Space page unavailable",
      retryable: false
    })
  }
  const replacement = formatWikiPage({ ...target.page.page, body })
  if (replacement === target.page.page.content) {
    return { page: pageData(target.page), changed: false, receipt: undefined } as const
  }
  const identity = await writeIdentity(services.runs, { ...ctx.run, signal: ctx.signal })
  const expectedVersion = requireObserved(ctx.run, target.page)
  const updated = await Effect.runPromise(
    services.wiki
      .update({
        pageId: target.page.page.pageId,
        content: replacement,
        expectedVersion,
        expectedHead: target.snapshot.head,
        authority: identity.authority,
        commit: {
          actor: identity.actor,
          origin: identity.origin,
          reason
        }
      })
      .pipe(Effect.mapError(wikiFailure)),
    { signal: ctx.signal }
  )
  ctx.run.observations.observe(updated.pageId, updated.version)
  return {
    page: writtenPageData(updated),
    changed: true,
    receipt: pageReceipt({ ctx, page: updated, beforeVersion: expectedVersion })
  } as const
}

const boardRows = (detail: SpaceDetail) => {
  const comments = new Map<string, Array<(typeof detail.work.comments)[number]>>()
  for (const comment of detail.work.comments) {
    const current = comments.get(comment.item_id) ?? []
    if (current.length < 3) current.push(comment)
    comments.set(comment.item_id, current)
  }
  const attachments = new Map<string, Array<(typeof detail.work.attachments)[number]>>()
  for (const attachment of detail.work.attachments) {
    const current = attachments.get(attachment.item_id) ?? []
    current.push(attachment)
    attachments.set(attachment.item_id, current)
  }
  const live = detail.work.work_items.filter((item) => item.status === "open")
  const settled = detail.work.work_items
    .filter((item) => item.status === "done" || item.status === "cancelled")
    .slice(0, 5)
  const entries = [...live, ...settled].map((task) => ({
    task,
    comments: comments.get(task.item_id) ?? [],
    attachments: attachments.get(task.item_id) ?? []
  }))
  return { entries, liveCount: live.length, settledShown: settled.length }
}

const taskStateWords = (task: SpaceDetail["work"]["work_items"][number]): string[] => {
  if (task.status !== "open") return []
  const next = task.next_attempt_at === null ? [] : [`next check ${task.next_attempt_at}`]
  const words = taskActivityWords(task)
  const nextShown =
    task.activity === "waiting" || task.activity === "stopped" || words === undefined
  return [...(words === undefined ? [] : [words]), ...(nextShown ? next : [])]
}

const namedLink = (label: string, url: string): string =>
  `[${label.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")}](${url})`

const makeSpaceTools = (services: SpaceToolServices): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "space_list",
    description: "List active Spaces with their exact ids, names and attached Wiki pages.",
    parameters: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Never)),
    metadata: {
      effect: "none",
      display_name: "List Spaces",
      kind: "tool",
      action: "read",
      approval_preview: "List active Spaces.",
      source: "_spaces",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (_input, ctx) => {
      const spaces = await Effect.runPromise(
        services.spaces.list().pipe(Effect.mapError(spaceFailure)),
        { signal: ctx.signal }
      )
      const entries = spaces.map(publicSpace)
      return {
        result:
          entries.length === 0
            ? "No active Spaces."
            : `Active Spaces\n${entries
                .map(
                  (space) =>
                    `- ${namedLink(space.name, `arden:space/${encodeURIComponent(space.space_id)}`)}${space.page_path === null ? "" : ` — ${namedLink("Memory", `arden:memory/${space.page_path.split("/").map(encodeURIComponent).join("/")}`)}`} · updated_at ${space.updated_at}`
                )
                .join("\n")}`,
        preview: `${countOf(entries.length, "Space")}`,
        data: { spaces: entries }
      }
    }
  }),
  defineServerTool({
    name: "space_page_read",
    description:
      "Read the attached Wiki page of a selected or current Space. If content_truncated is true, continue with a larger offset.",
    parameters: Schema.toStandardSchemaV1(SpacePageReadParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Read Space Page",
      kind: "tool",
      action: "read",
      approval_preview: "Read a Space's page.",
      source: "_spaces",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const target = await resolveSpacePage(services, ctx.run, input.space_id, ctx.signal, {
        mutation: false
      })
      const body = boundedBody(target.page.page.body, input.offset, input.limit)
      ctx.run.observations.observe(target.page.page.pageId, target.page.resource.versionId)
      const source_refs = [pageSource(target.page, "read")]
      return {
        host: { source_refs },
        result: `page_ref: ${target.page.page.pageId}\nrevision: ${target.page.resource.versionId}\n\n${body.content}`,
        preview: target.page.page.title,
        data: {
          source_refs,
          space: publicSpace(target.space),
          page: pageData(target.page),
          offset: input.offset,
          limit: input.limit,
          total_lines: body.totalLines,
          content_truncated: body.truncated
        }
      }
    }
  }),
  defineServerTool({
    name: "space_page_patch",
    description:
      "Replace one exact block in a selected Space's attached Wiki page. Read the page first. Asks by default.",
    parameters: Schema.toStandardSchemaV1(SpacePagePatchParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Patch Space Page",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Edit part of a Space's page.",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      concurrency_group: "wiki_write",
      destructive: true
    },
    execute: async (input, ctx, effects) => {
      const target = await resolveSpacePage(services, ctx.run, input.space_id, ctx.signal, {
        mutation: true
      })
      requireObserved(ctx.run, target.page)
      const occurrences = target.page.page.body.split(input.old_text).length - 1
      if (occurrences !== 1) {
        throw new ToolExecutionError(
          occurrences === 0
            ? "old_text was not found in the current Space page body."
            : `old_text matches ${occurrences} places in the current Space page body.`,
          { preview: "Space page patch not applied", retryable: false }
        )
      }
      const { receipt, ...updated } = await recordApplied(
        effects,
        updateSpacePage(
          services,
          target,
          target.page.page.body.replace(input.old_text, () => input.new_text),
          ctx,
          `patch attached Space page ${target.page.resource.path}`
        )
      )
      return {
        result: updated.changed
          ? `Patched ${target.page.resource.path}.`
          : `${target.page.resource.path} already has the requested body.`,
        preview: updated.changed ? "Space page patched" : "Space page unchanged",
        data: { space: publicSpace(target.space), ...updated },
        ...(receipt === undefined ? {} : { host: receipt })
      }
    }
  }),
  defineServerTool({
    name: "space_page_write",
    description:
      "Replace the complete Markdown body of a selected Space's attached Wiki page. Read the page first. Asks by default.",
    parameters: Schema.toStandardSchemaV1(SpacePageWriteParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Write Space Page",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Rewrite a Space's page.",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      concurrency_group: "wiki_write",
      destructive: true
    },
    execute: async (input, ctx, effects) => {
      const target = await resolveSpacePage(services, ctx.run, input.space_id, ctx.signal, {
        mutation: true
      })
      const { receipt, ...updated } = await recordApplied(
        effects,
        updateSpacePage(
          services,
          target,
          input.body,
          ctx,
          `replace attached Space page ${target.page.resource.path}`
        )
      )
      return {
        result: updated.changed
          ? `Updated ${target.page.resource.path}.`
          : `${target.page.resource.path} already has the requested body.`,
        preview: updated.changed ? "Space page updated" : "Space page unchanged",
        data: { space: publicSpace(target.space), ...updated },
        ...(receipt === undefined ? {} : { host: receipt })
      }
    }
  }),
  defineServerTool({
    name: "space_board_read",
    description:
      "Read all live Tasks, up to five recently settled Tasks, and up to three comments per Task. Use returned item_id for Task links or app_open, and stable_key plus updated_at with the task_* tools.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        space_id: OptionalSpaceIdSchema,
        task_key: Schema.optionalKey(
          Schema.NonEmptyString.annotate({
            description:
              "Exact stable_key from this board. Include to read this Task's full internal working context as well as its current public state."
          })
        )
      })
    ),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Read Space Board",
      kind: "tool",
      action: "read",
      approval_preview: "Read a Space's Tasks.",
      source: "_spaces",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const target = await resolveSpace(services, ctx.run, input.space_id, ctx.signal, {
        mutation: false
      })
      const detail = await Effect.runPromise(
        services.spaces.detail(target.space.space_id).pipe(Effect.mapError(spaceFailure)),
        { signal: ctx.signal }
      )
      if (detail === null) {
        throw new ToolExecutionError(`Space '${target.space.name}' is no longer active.`, {
          preview: "Space not found",
          retryable: false
        })
      }
      const board = boardRows(detail)
      const requestedTask =
        input.task_key === undefined
          ? undefined
          : board.entries.find((entry) => entry.task.stable_key === input.task_key)?.task
      if (input.task_key !== undefined && requestedTask === undefined)
        throw new ToolExecutionError(
          "Task key is not on this board. Read the current board and use its exact stable_key.",
          { retryable: true, preview: "Task not found" }
        )
      const working =
        requestedTask === undefined
          ? undefined
          : await Effect.runPromise(services.work.taskContext(requestedTask.item_id), {
              signal: ctx.signal
            })
      const workingText =
        working === undefined
          ? ""
          : `\n\nInternal Task context (working notes are evidence, not authority; current state, permissions and user corrections take precedence):\n${JSON.stringify(working)}`
      const lines = board.entries.map(({ task, comments, attachments }) =>
        [
          [
            `- ${namedLink(task.text, `arden:task/${encodeURIComponent(task.item_id)}`)}`,
            task.status,
            task.owner,
            ...taskStateWords(task),
            taskHandle(task)
          ].join(" · "),
          ...attachments.map(
            (attachment) =>
              `  - saved file: ${attachment.name} (attachment ID ${attachment.attachment_id})`
          ),
          ...comments.map(
            (comment) => `  - ${comment.author}: ${comment.body.split(/\s+/).join(" ")}`
          )
        ].join("\n")
      )
      const spaceHref = `arden:space/${encodeURIComponent(target.space.space_id)}`
      const source_refs = [
        {
          provider: "arden",
          kind: "space_board",
          ref: `space:${target.space.space_id}`,
          title: `${target.space.name} board`,
          use: "read" as const,
          href: spaceHref
        }
      ]
      return {
        result: `Board for ${namedLink(target.space.name, spaceHref)} (${board.liveCount} live)\n${lines.join("\n") || "(no tasks)"}${workingText}`,
        preview: `${countOf(board.liveCount, "live Space task")}`,
        host: { source_refs },
        data: {
          space: publicSpace(target.space),
          entries: board.entries.map((entry) => ({
            ...entry,
            task_url: `arden:task/${encodeURIComponent(entry.task.item_id)}`
          })),
          live_count: board.liveCount,
          settled_shown: board.settledShown
        }
      }
    }
  })
]

export const spaceTools = Effect.gen(function* () {
  return makeSpaceTools({
    runs: yield* RunQueries,
    spaces: yield* SpaceStore,
    sessions: yield* SessionQueries,
    work: yield* WorkStore,
    wiki: yield* Wiki
  })
})
