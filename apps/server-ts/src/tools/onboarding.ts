import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"
import { GoogleDesktopClientFileSchema } from "@arden-hq/protocol/effect/google"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { Effect, Option, Schema } from "effect"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join } from "node:path"

import { readSpecialChat } from "../context/special-chat.js"
import { GoogleConnections } from "../google/service.js"
import { ApprovalPolicyStore } from "../persistence/permissions/approval-policy.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { Wiki } from "../wiki/service.js"
import {
  digestAgentKnowledge,
  findAgentKnowledge,
  importAgentKnowledge,
  SKIP_WORDS,
  type KnowledgeTarget
} from "./agent-knowledge.js"
import { makeBrowserHistorySummaryTool } from "./browser-history.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { writeIdentity, type WikiWriteIdentity } from "./wiki-identity.js"
import { wikiFailure } from "./wiki.js"
import { recordApplied, type CallEffects } from "../execution/tool-effect.js"
import { appliedReceipt } from "./call-receipt.js"
import { pagesReceipt } from "./wiki-records.js"
import { toolFailure } from "./tool-failure.js"

const EmptyParametersSchema = Schema.Record(Schema.String, Schema.Never)

const KnowledgeImportParametersSchema = Schema.Struct({
  include_project_memories: Schema.Boolean.annotate({
    description:
      "Also copy Claude Code's per-repo project memories (~/.claude/projects/*/memory/). Only when the user asked for them. Defaults to false."
  }).pipe(Schema.withDecodingDefault(Effect.succeed(false)))
})

export const APPROVAL_MODE_LABEL: Record<ChatApprovalMode, string> = {
  read_only: "Read only",
  ask: "Ask every time",
  safe: "Auto",
  allow: "Never ask"
}

const ApprovalModeParametersSchema = Schema.Struct({
  mode: ApprovalModeSchema.annotate({
    description:
      "The mode the user chose: read_only (Read only), ask (Ask every time), safe (Auto, the default) or allow (Never ask)."
  })
})

const TOUR_GROUPS = ["getting_around", "your_work", "talking", "you", "all"] as const

const TourParametersSchema = Schema.Struct({
  group: Schema.Literals(TOUR_GROUPS)
    .annotate({
      description:
        "Which part to show: getting_around (the sidebar and places), your_work (Tasks and Automations), talking (the message box), you (Memory and settings), or all. Defaults to all."
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("all" as const)))
})

const GoogleClientParametersSchema = Schema.Struct({
  path: Schema.optionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
      description:
        "Absolute path of the downloaded client JSON. Omit to use the newest client_secret_*.json in ~/Downloads."
    })
  )
})

const MAX_CLIENT_FILE_BYTES = 64 * 1024

interface OnboardingToolServices {
  readonly sessions: SessionQueries["Service"]
  readonly policy: ApprovalPolicyStore["Service"]
  readonly wiki: Wiki["Service"]
  readonly runs: RunQueries["Service"]
  readonly google: GoogleConnections["Service"]
  readonly home?: string
}

const makeOnboardingTools = ({
  sessions,
  policy,
  wiki,
  runs,
  google,
  home = homedir()
}: OnboardingToolServices): ReadonlyArray<ServerTool> => [
  makeBrowserHistorySummaryTool({ home }),

  defineServerTool({
    name: "agent_knowledge_scan",
    description: [
      "List what the user taught other coding assistants on this Mac. Instructions: Claude Code (~/.claude/CLAUDE.md, ~/.claude/rules/*.md) and Codex (~/.codex/AGENTS.md, ~/.codex/memories/*.md).",
      "Separately, Claude Code's project memories (~/.claude/projects/*/memory/): per-repo working notes, imported only when the user asks for them.",
      "Returns file paths and sizes, never contents."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
    metadata: {
      effect: "none",
      display_name: "Find Other Assistants' Notes",
      kind: "tool",
      action: "read",
      approval_preview: "List notes other assistants keep on this Mac (names only).",
      source: "_local",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async () => {
      const knowledge = await findAgentKnowledge(home)
      const projectFiles = knowledge.projectMemories.reduce(
        (total, memory) => total + memory.files.length,
        0
      )
      const found = knowledge.instructions.length > 0 || projectFiles > 0
      return {
        result: found
          ? [
              ...knowledge.instructions.map(
                (source) =>
                  `${source.label} instructions: ${source.files.map((file) => file.display).join(", ")}`
              ),
              ...(projectFiles === 0
                ? []
                : [
                    `Claude Code project memories (optional, not imported by default): ${countOf(projectFiles, "file")} across ${knowledge.projectMemories.map((memory) => `${memory.project} (${memory.files.length})`).join(", ")}`
                  ])
            ].join("\n")
          : "No Claude Code or Codex notes were found.",
        preview: found
          ? [
              ...knowledge.instructions.map((source) => `${source.label} ${source.files.length}`),
              ...(projectFiles === 0 ? [] : [`${projectFiles} project notes`])
            ].join(", ")
          : "No notes found",
        data: {
          instructions: knowledge.instructions.map((source) => ({
            app: source.app,
            label: source.label,
            files: source.files.map((file) => ({ path: file.display, bytes: file.bytes }))
          })),
          project_memories: knowledge.projectMemories.map((memory) => ({
            project: memory.project,
            path: memory.display,
            count: memory.files.length
          }))
        }
      }
    }
  }),

  defineServerTool({
    name: "agent_knowledge_import",
    description: [
      "Copy the user's Claude Code and Codex instructions (the files agent_knowledge_scan lists as instructions) into Memory as read-only reference pages under imported/claude-code/ and imported/codex/, in one change.",
      "Set include_project_memories only when the user asked for their per-repo project memories too.",
      "Call only after the user agreed in this chat. Importing again refreshes changed files and leaves unchanged ones; files that look like they hold secrets are skipped and reported."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(KnowledgeImportParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Import Other Assistants' Notes",
      kind: "tool",
      action: "write",
      approval_preview: "Copy Claude Code and Codex notes into Memory.",
      source: "_wiki",
      changes_state: true,
      target: "reported",
      default_approval: "approve",
      concurrency_group: "wiki_write",
      destructive: false
    },
    execute: async (input, ctx, effects) => {
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const imported = await importAgentKnowledge({
        home,
        includeProjectMemories: input.include_project_memories,
        target: wikiKnowledgeTarget(wiki, identity, ctx.signal, effects)
      })
      if (imported.created.length + imported.updated.length === 0) effects.unchanged()
      const copied = imported.created.length + imported.updated.length
      const receipt = pagesReceipt(ctx, imported.committed)
      return {
        ...(receipt === undefined ? {} : { host: receipt }),
        result: [
          `Imported ${countOf(copied, "page")} (${imported.created.length} new, ${imported.updated.length} refreshed); ${imported.unchanged.length} already current.`,
          ...imported.skipped.map((skip) => `Skipped ${skip.path}: ${SKIP_WORDS[skip.reason]}.`),
          "Read what they say with agent_knowledge_digest. Link a page as [Page](arden:memory/<path>)."
        ].join("\n"),
        preview: `${copied} notes imported`,
        data: {
          created: imported.created,
          updated: imported.updated,
          unchanged: imported.unchanged,
          skipped: imported.skipped
        }
      }
    }
  }),

  defineServerTool({
    name: "agent_knowledge_digest",
    description: [
      "Read what the user taught Claude Code and Codex: the text of their instruction files, then each Claude Code project memory folder's index, each under its file path, within a fixed budget.",
      "Use it to learn how the user works and what they are building; cite a fact by its file path. Files that look like they hold secrets are named, never read."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
    metadata: {
      effect: "none",
      display_name: "Read Other Assistants' Notes",
      kind: "tool",
      action: "read",
      approval_preview: "Read the notes other assistants keep on this Mac.",
      source: "_local",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async () => {
      const digest = await digestAgentKnowledge({ home })
      return { result: digest, preview: "Read their notes", data: { chars: digest.length } }
    }
  }),

  defineServerTool({
    name: "approval_mode_set",
    description: [
      "Set how much this chat, and every new chat, checks with the user before acting, after the user chose it in the Getting started chat.",
      "Only the onboarding chat may call this; everywhere else the user changes it from the shield under the message box."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ApprovalModeParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Set Approval Mode",
      kind: "tool",
      action: "write",
      approval_preview: "Change how much this chat and new chats ask before acting.",
      source: "_app",
      changes_state: true,
      target: "reported",
      concurrency_group: null,
      destructive: false
    },
    execute: async (input, ctx, effects) => {
      const session = await Effect.runPromise(sessions.loadHeaderSnapshot(ctx.run.sessionId), {
        signal: ctx.signal
      })
      if (session === null || readSpecialChat(session.metadata)?.kind !== "onboarding") {
        throw new ToolExecutionError(
          "Only the Getting started chat sets its approval mode. Tell the user to use the shield under the message box.",
          { preview: "Not available here", retryable: false }
        )
      }
      await recordApplied(
        effects,
        Effect.runPromise(
          policy.setSession({ sessionId: ctx.run.sessionId, mode: input.mode }).pipe(
            Effect.andThen(policy.setDefaultMode(input.mode)),
            Effect.mapError((error) =>
              toolFailure(
                {
                  reason: error.reason,
                  message: `The approval mode was not changed: ${error.message}`
                },
                "Mode unchanged"
              )
            )
          ),
          { signal: ctx.signal }
        )
      )
      return {
        result: `This chat now uses ${APPROVAL_MODE_LABEL[input.mode]}.`,
        preview: APPROVAL_MODE_LABEL[input.mode],
        data: { mode: input.mode },
        host: appliedReceipt(ctx, {
          kind: "target",
          resourceRef: `approval_mode:${session.header.sessionId}`,
          domain: "session",
          title: `Approval mode: ${APPROVAL_MODE_LABEL[input.mode]}`,
          href: `arden:session/${encodeURIComponent(session.header.publicRef)}`
        })
      }
    }
  }),

  defineServerTool({
    name: "show_tour",
    description:
      "Start the app's guided tour, which points at the real sidebar and message box. Use it when the user asks to be shown around. Returns at once; the app runs the tour.",
    parameters: Schema.toStandardSchemaV1(TourParametersSchema),
    metadata: {
      display: { app: "tour" },
      effect: "none",
      display_name: "Show Me Around",
      kind: "tool",
      action: "read",
      approval_preview: "Show a short tour of the app.",
      source: "_app",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input) => ({
      result:
        "The tour started. End your turn with no text; the user comes back to this chat when it ends.",
      preview: "Tour started",
      data: { started: true, group: input.group }
    })
  }),

  defineServerTool({
    name: "google_client_import",
    description: [
      "Import the user's own Google OAuth client (a Desktop app client JSON downloaded from Google Cloud) so Arden can connect Gmail, Calendar and Drive.",
      "Reads the newest client_secret_*.json in ~/Downloads unless a path is given. The secret is stored in Arden's vault and never returned. Load the google-setup Skill before the first call."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(GoogleClientParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Import Google Client",
      kind: "tool",
      action: "write",
      approval_preview: "Import your Google OAuth client from Downloads.",
      source: "_app",
      changes_state: true,
      target: "reported",
      concurrency_group: null,
      destructive: false
    },
    execute: async (input, ctx, effects) => {
      const file = input.path ?? (await newestClientFile(join(home, "Downloads")))
      if (file === undefined || !isAbsolute(file)) {
        throw new ToolExecutionError(
          "No client_secret_*.json was found in ~/Downloads. Download the Desktop client JSON from Google Cloud, then retry.",
          { preview: "Client file not found", retryable: true }
        )
      }
      const client = await readClientFile(file)
      const configured = await Effect.runPromise(
        google
          .configureClient({ clientId: client.clientId, clientSecret: client.clientSecret })
          .pipe(Effect.mapError((error) => toolFailure(error, "Google client not saved"))),
        { signal: ctx.signal }
      )
      if (configured.status === "blocked") {
        effects.unchanged()
        return {
          result:
            configured.reason === "accounts_connected"
              ? "Not imported: Google accounts are already connected with another client. Disconnect them in Settings first, or keep the current client."
              : "Not imported: a Google sign-in is in progress. Finish or cancel it, then retry.",
          preview: "Google client not changed",
          data: { status: "blocked", reason: configured.reason, file: basename(file) }
        }
      }
      effects.applied()
      return {
        host: appliedReceipt(ctx, {
          kind: "target",
          resourceRef: `google_client:${client.clientId}`,
          domain: "other",
          title:
            client.projectId === undefined ? "Google client" : `Google client: ${client.projectId}`,
          href: "arden:settings/integrations"
        }),
        result: `Imported the Google client from ${basename(file)}${client.projectId === undefined ? "" : ` (project ${client.projectId})`}. Connect each service next.`,
        preview: "Google client imported",
        data: {
          status: "configured",
          file: basename(file),
          ...(client.projectId === undefined ? {} : { project_id: client.projectId })
        }
      }
    }
  })
]

const wikiKnowledgeTarget = (
  wiki: Wiki["Service"],
  identity: WikiWriteIdentity,
  signal: AbortSignal,
  effects: CallEffects
): KnowledgeTarget => ({
  write: ({ directories, pages }) =>
    recordApplied(
      effects,
      Effect.runPromise(
        wiki
          .importReferencePages({
            directories,
            pages,
            authority: identity.authority,
            commit: {
              actor: identity.actor,
              origin: identity.origin,
              reason: `import ${countOf(pages.length, "note")} from other assistants`
            }
          })
          .pipe(Effect.mapError(wikiFailure)),
        { signal }
      )
    )
})

const newestClientFile = async (downloads: string): Promise<string | undefined> => {
  const names = (await readdir(downloads).catch(() => [])).filter((name) =>
    /^client_secret_.*\.json$/.test(name)
  )
  const dated = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(downloads, name)).catch(() => undefined)
      return info?.isFile() === true ? [{ path: join(downloads, name), at: info.mtimeMs }] : []
    })
  )
  return dated.flat().sort((left, right) => right.at - left.at)[0]?.path
}

const readClientFile = async (
  file: string
): Promise<{
  readonly clientId: string
  readonly clientSecret: string
  readonly projectId: string | undefined
}> => {
  const info = await stat(file).catch(() => undefined)
  if (info?.isFile() !== true || info.size > MAX_CLIENT_FILE_BYTES) {
    throw new ToolExecutionError(`${basename(file)} is not a Google client file.`, {
      preview: "Not a client file",
      retryable: false
    })
  }
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(GoogleDesktopClientFileSchema))(
    await readFile(file, "utf8")
  )
  if (Option.isNone(decoded)) {
    throw new ToolExecutionError(
      `${basename(file)} is not a Desktop app OAuth client. In Google Cloud, create an OAuth client of type Desktop app and download its JSON.`,
      { preview: "Not a Desktop client", retryable: false }
    )
  }
  const installed = decoded.value.installed
  return {
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    projectId: installed.project_id
  }
}

export const onboardingTools = Effect.gen(function* () {
  return makeOnboardingTools({
    sessions: yield* SessionQueries,
    policy: yield* ApprovalPolicyStore,
    wiki: yield* Wiki,
    runs: yield* RunQueries,
    google: yield* GoogleConnections
  })
})
