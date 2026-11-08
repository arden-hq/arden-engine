import { formatBytes } from "@arden-hq/std/count"
import { isWithin } from "@arden-hq/std/paths"
import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { Effect, Predicate, Schema } from "effect"
import { isAbsolute, join, relative, sep } from "node:path"

import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import { appliedReceipt } from "./call-receipt.js"
import type { ServerRunContext } from "./run-context.js"
import {
  ConversationArtifacts,
  type ConversationArtifactError,
  type ConversationArtifactManifest
} from "../artifacts/conversation.js"
import { ManagedOutputs } from "../artifacts/managed-output/managed-output.js"
import { recordApplied } from "../execution/tool-effect.js"
import { errorMessage } from "@arden-hq/std/errors"
import { managedObjectRefParts } from "../persistence/managed-output/descriptor.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { sessionLineage } from "../persistence/sessions/lineage.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { toolFailure } from "./tool-failure.js"

const ARTIFACT_REF = /^(?:viz|file)-[a-f0-9]{32}$/

const MAX_ITEMS = 20

const ParametersSchema = Schema.Struct({
  refs: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)))
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ITEMS))
    .annotate({
      description:
        "What to delete: the artifact_ref or path artifact_save, browser_screenshot or exec_command returned, or an arden:managed-output/ reference from this chat."
    })
})

type Input = typeof ParametersSchema.Type

type Item =
  | {
      readonly kind: "artifact"
      readonly session: string
      readonly manifest: ConversationArtifactManifest
      readonly path: string
      readonly madeHere: boolean
    }
  | {
      readonly kind: "output"
      readonly ref: string
      readonly digest: string
      readonly bytes: number | undefined
    }

interface Services {
  readonly artifacts: Pick<
    ConversationArtifacts["Service"],
    "manifest" | "rootPath" | "removeArtifact"
  >
  readonly outputs: Pick<ManagedOutputs["Service"], "removeFromSession" | "size">
  readonly sessions: SessionQueries["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "authority">
}

const refused = (message: string, preview: string): ToolExecutionError =>
  new ToolExecutionError(message, { preview, retryable: false })

const storeFailure = (error: ConversationArtifactError): ToolExecutionError =>
  error.reason === "not_found"
    ? refused("No such artifact in this chat; it may already be deleted.", "Artifact not found")
    : toolFailure(error, "Artifact unavailable")

const isNotFound = (cause: unknown): boolean =>
  Predicate.hasProperty(cause, "reason") && cause.reason === "not_found"

const makeArtifactDeleteTool = (services: Services): ServerTool => {
  const resolve = async (input: Input, ctx: ToolContext<ServerRunContext>) => {
    const lineage = await Effect.runPromise(sessionLineage(services.sessions, ctx.run.sessionId), {
      signal: ctx.signal
    })
    const treeRoot = lineage.at(-1)?.sessionId
    if (treeRoot === undefined)
      throw new ToolExecutionError("The artifact owner could not be resolved", {
        preview: "Artifact owner unavailable",
        retryable: true
      })
    const folders = await Promise.all(
      [...new Set([ctx.run.sessionId, treeRoot])].map(async (session) => ({
        session,
        root: await Effect.runPromise(services.artifacts.rootPath(session), {
          signal: ctx.signal
        })
      }))
    )
    const items: Array<Item> = []
    for (const given of new Set(input.refs)) {
      const parts = managedObjectRefParts(given)
      if (parts !== undefined) {
        if (parts.owner !== sha256Hex(ctx.run.sessionId))
          throw refused(`${given} belongs to another chat.`, "Not this chat's output")
        items.push({
          kind: "output",
          ref: given,
          digest: parts.digest,
          bytes: await services.outputs.size({ sessionId: ctx.run.sessionId, ref: given })
        })
        continue
      }
      const found = await findArtifact(given, folders, ctx.signal)
      items.push({
        kind: "artifact",
        ...found,
        madeHere: await madeByThisTree(found.manifest, treeRoot, ctx, ctx.signal)
      })
    }
    return { items }
  }

  const findArtifact = async (
    given: string,
    folders: ReadonlyArray<{ readonly session: string; readonly root: string }>,
    signal: AbortSignal
  ) => {
    const candidates = folders.flatMap((folder) => {
      const ref = artifactRefIn(given, folder.root)
      return ref === undefined ? [] : [{ ...folder, ref }]
    })
    if (candidates.length === 0)
      throw refused(
        `${given} is not one of this chat's artifacts. Only files Arden saved in this chat can be deleted here.`,
        "Not this chat's artifact"
      )
    for (const candidate of candidates) {
      const manifest = await Effect.runPromise(
        services.artifacts.manifest(candidate.session, candidate.ref).pipe(
          Effect.catch((error) =>
            error.reason === "not_found" ? Effect.succeed(undefined) : Effect.fail(error)
          ),
          Effect.mapError(storeFailure)
        ),
        { signal }
      )
      if (manifest !== undefined)
        return {
          session: candidate.session,
          manifest,
          path: join(candidate.root, candidate.ref, manifest.filename)
        }
    }
    throw refused("No such artifact in this chat; it may already be deleted.", "Artifact not found")
  }

  const madeByThisTree = async (
    manifest: ConversationArtifactManifest,
    treeRoot: string,
    ctx: ToolContext<ServerRunContext>,
    signal: AbortSignal
  ): Promise<boolean> => {
    if (manifest.producer_run_id === undefined) return false
    const run = await Effect.runPromise(services.runs.get(manifest.producer_run_id), { signal })
    if (run === null) return false
    const producer = await Effect.runPromise(
      sessionLineage(services.sessions, run.sessionId).pipe(Effect.catch(() => Effect.succeed([]))),
      { signal }
    )
    if (producer.at(-1)?.sessionId !== treeRoot) return false
    const automation = ctx.run.authority.owns.automation_id
    if (automation === null) return true
    const made = await Effect.runPromise(services.runs.authority(manifest.producer_run_id), {
      signal
    })
    return made?.owns.automation_id === automation
  }

  return defineServerTool({
    name: "artifact_delete",
    description: [
      "Delete files Arden saved in this chat: artifacts (artifact_save, screenshots, command output) and saved full outputs.",
      "Use it when such a file should not be kept; exec_command cannot remove Arden's own storage.",
      "A file this chat or its agents saved is deleted at once; in an Automation's run, only files that Automation's runs saved are.",
      "Anything else in the chat's storage asks the person first. Other chats' files, settings and Arden's database are never reachable."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      effect: "arden_db",
      scopes: ["agent_research"],
      display_name: "Delete artifact",
      kind: "filesystem",
      action: "write",
      approval_preview: "Delete files Arden saved in this chat.",
      source: "_filesystem",
      changes_state: true,
      target: "reported",
      concurrency_group: "conversation_artifacts",
      destructive: true,
      default_approval: "approve",
      approval_bypass: true
    },
    approvalPrompt: async (input, ctx) => card((await resolve(input, ctx)).items),
    approvalRequirement: async (input, ctx) => {
      const { items } = await resolve(input, ctx)
      return items.some((item) => item.kind === "artifact" && !item.madeHere)
        ? card(items)
        : undefined
    },
    execute: async (input, ctx, effects) => {
      const { items } = await resolve(input, ctx)
      const deleted: Array<Item> = []
      const missing: Array<string> = []
      const leftOnDisk: Array<string> = []
      let failure: unknown
      for (const item of items) {
        try {
          if (item.kind === "artifact") {
            const removed = await recordApplied(
              effects,
              Effect.runPromise(services.artifacts.removeArtifact(item.session, item.manifest.ref))
            )
            deleted.push(item)
            if (!removed.bytesRemoved) leftOnDisk.push(item.manifest.title)
            continue
          }
          const removed = await services.outputs.removeFromSession({
            sessionId: ctx.run.sessionId,
            ref: item.ref
          })
          if (removed) {
            effects.applied()
            deleted.push(item)
          } else missing.push(item.ref)
        } catch (cause) {
          if (item.kind === "artifact" && isNotFound(cause)) {
            missing.push(item.manifest.ref)
            continue
          }
          failure = cause
          break
        }
      }
      if (deleted.length === 0) {
        if (failure !== undefined)
          throw failure instanceof ToolExecutionError
            ? failure
            : new ToolExecutionError(errorMessage(failure), {
                preview: "Artifact could not be deleted",
                retryable: true
              })
        effects.unchanged()
        return {
          result: "Nothing was deleted: none of these is stored in this chat any more.",
          preview: "Nothing to delete",
          data: { deleted: [], missing }
        }
      }
      const names = deleted.map(itemName)
      const notes = [
        missing.length === 0 ? undefined : `Not stored: ${missing.join(", ")}.`,
        leftOnDisk.length === 0
          ? undefined
          : `The bytes of ${leftOnDisk.join(", ")} could not be removed yet; they are out of the chat and go at the next delete or listing.`,
        failure === undefined ? undefined : `Stopped before the rest: ${errorMessage(failure)}`
      ].filter((note) => note !== undefined)
      return {
        result: [`Deleted ${names.join(", ")}.`, ...notes].join(" "),
        preview: deleted.length === 1 ? `Deleted ${names[0]}` : `Deleted ${deleted.length} files`,
        data: {
          deleted: deleted.map((item) =>
            item.kind === "artifact"
              ? { ref: item.manifest.ref, title: item.manifest.title, path: item.path }
              : { ref: item.ref, title: itemName(item) }
          ),
          missing,
          bytes_left: leftOnDisk
        },
        host: appliedReceipt(
          ctx,
          deleted.map((item) =>
            item.kind === "artifact"
              ? {
                  kind: "versioned_resource" as const,
                  resourceRef: `output:${item.manifest.ref}`,
                  beforeVersion: item.manifest.sha256,
                  afterVersion: "absent",
                  domain: "file" as const,
                  title: item.manifest.title
                }
              : {
                  kind: "versioned_resource" as const,
                  resourceRef: item.ref,
                  beforeVersion: item.digest,
                  afterVersion: "absent",
                  domain: "file" as const,
                  title: itemName(item)
                }
          )
        )
      }
    }
  })
}

const artifactRefIn = (given: string, root: string): string | undefined => {
  if (ARTIFACT_REF.test(given)) return given
  if (!isAbsolute(given)) return undefined
  if (!isWithin(root, given)) return undefined
  const ref = relative(root, given).split(sep)[0]
  return ref === undefined || !ARTIFACT_REF.test(ref) ? undefined : ref
}

const itemName = (item: Item): string =>
  item.kind === "artifact" ? item.manifest.title : "Saved full output"

const cardLine = (item: Item): string => {
  if (item.kind === "output")
    return item.bytes === undefined
      ? `${itemName(item)} (not stored, ${item.digest.slice(0, 8)})`
      : `${itemName(item)} (${formatBytes(item.bytes)}, ${item.digest.slice(0, 8)})`
  const facts = `${formatBytes(item.manifest.byte_length)}, ${item.manifest.sha256.slice(0, 8)}`
  return item.madeHere
    ? `${itemName(item)} (${facts})`
    : `${itemName(item)} (${facts}, not saved by this chat)`
}

const card = (items: ReadonlyArray<Item>): ServerApprovalPrompt => ({
  preview:
    items.length === 1 && items[0] !== undefined
      ? `Delete ${itemName(items[0])}`
      : `Delete ${items.length} files`,
  presentation: {
    title: items.length === 1 ? "Delete this saved file?" : "Delete these saved files?",
    fields: [],
    body: { label: "Files", text: items.map(cardLine).join("\n") },
    approve_label: "Delete"
  }
})

export const artifactDeleteTools = Effect.gen(function* () {
  return [
    makeArtifactDeleteTool({
      artifacts: yield* ConversationArtifacts,
      outputs: yield* ManagedOutputs,
      sessions: yield* SessionQueries,
      runs: yield* RunQueries
    })
  ]
})
