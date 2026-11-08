import { APPROVAL_MODE_LABEL } from "../tools/onboarding.js"
import type { LiveRead, ToolApprovalPolicy } from "../tools/approval-policy.js"
import { ToolExecutionError } from "@arden-hq/loop"
import { Effect } from "effect"
import { pathToFileURL } from "node:url"

import { PROMPT_CATALOG } from "../prompts/catalog.js"
import { renderPromptSection } from "../prompts/format.js"
import {
  sessionPathPolicy,
  type LocalPathContext,
  type LocalPathServices
} from "../storage/local-paths.js"
import { writeIdentity } from "../tools/wiki-identity.js"
import { boundAuthority } from "../chat/run-authority.js"
import type { RunAuthority } from "../execution/authority.js"
import { refusalPath, type Path } from "../execution/decide.js"
import type { RunQueries } from "../persistence/runs/queries.js"
import { resolveWikiWriteBoundary } from "../wiki/authority.js"
import type { Wiki } from "../wiki/service.js"

export const renderAuthority = (authority: RunAuthority): string | undefined => {
  const actor = authority.actor
  const otherwise = (paths: ReadonlyArray<Path>) =>
    ` For anything else, ${paths.map(pathWords).join(", or ")}.`
  switch (actor.kind) {
    case "person":
      return undefined
    case "automation":
      return `You are an Automation run. You may change this Automation, Work on its own Space and its Memory, and create a Task on another Space.${otherwise(refusalPath(actor))}`
    case "task_worker":
      return `You are working one Task. You may record its run fields and outcome, and create Tasks on other Spaces.${otherwise(refusalPath(actor))}`
    case "space_review":
      return `You are this Space's review. You may record the review's outcome and propose Work on this Space.${otherwise(refusalPath(actor))}`
    case "agent":
      return `You are a ${actor.mode} agent started by ${actor.root === "person" ? "the user's chat" : "a job"}. You stay within what it may do, narrowed to your mode.${otherwise(refusalPath(actor))}`
    case "unrecorded":
      return `This run's authority was not recorded: you may read and record what you found, nothing more.${otherwise(refusalPath(actor))}`
  }
}

const pathWords = (path: Path): string => {
  switch (path.kind) {
    case "tool":
      return `use ${path.name}`
    case "ask_user":
      return "ask the user"
    case "report":
      return "say it in your report"
  }
}

const fileLink = (path: string): string => `[Local folder](${pathToFileURL(path).href})`

const permissionsLine = (live: LiveRead, person: boolean): string => {
  const mode = `Approval mode: ${APPROVAL_MODE_LABEL[live.mode]}.`
  if (!person) return mode
  const own = live.rules.own
  const global = live.rules.rules.filter((rule) => rule.list.kind === "global").length
  const ownCount = live.rules.rules.length - global
  const lists =
    own === undefined
      ? `${global} everywhere`
      : `${ownCount} ${own.kind === "space" ? "in this Space" : "for Arden's own jobs"} and ${global} everywhere`
  return `${mode} Permission rules: ${lists}. Read them with permissions_read before you say what the mode or a rule covers.`
}

export const effectiveAccessContext = async (
  services: LocalPathServices & {
    readonly wiki: Wiki["Service"]
    readonly runs: Pick<RunQueries["Service"], "get" | "authority" | "cause">
    readonly permissions: ToolApprovalPolicy
  },
  context: LocalPathContext & { readonly authority: RunAuthority }
): Promise<string> => {
  const permissions = await Effect.runPromise(
    services.permissions.live({ runId: context.runId, authority: context.authority }).pipe(
      Effect.map((live) => permissionsLine(live, context.authority.actor.kind === "person")),
      Effect.orElseSucceed(
        () => "The approval mode and rules could not be read. Do not say what they cover."
      )
    )
  )
  const folders = await sessionPathPolicy(services, context).then(
    (policy) => {
      if (policy.sandbox === "code_agent") {
        if (policy.writeRoot === null || policy.cwd === null)
          throw new Error("Code-agent folder is missing")
        return `Code-agent writes stay inside ${fileLink(policy.writeRoot)}. File tools and commands read the whole machine except secret folders; commands have no network until approved. It works in ${fileLink(policy.cwd)}.`
      }
      return "Commands start in the home folder; use absolute or ~ paths. Reads work anywhere; writes follow the rules, then the approval mode. Folders Arden may change without asking are rules (permissions_read). Do not ask the user for a folder first: a write elsewhere asks on its card, which can keep its folder as a rule for this Space."
    },
    (cause: unknown) =>
      cause instanceof ToolExecutionError
        ? `Local folder unavailable: ${cause.message}`
        : "Local folder authority could not be inspected. Do not guess a working directory."
  )
  const authority = await Effect.runPromise(boundAuthority(services.runs, context))
  const memory = await writeIdentity(services.runs, { ...context, authority })
    .then(async ({ authority }) => {
      if (authority._tag === "Global") {
        return "Memory location authority is global; available tools, approvals and Memory directory rules still apply."
      }
      const boundary = await Effect.runPromise(
        Effect.gen(function* () {
          const snapshot = yield* services.wiki.snapshot()
          return yield* resolveWikiWriteBoundary(services.spaces, authority, snapshot, "update")
        }),
        { signal: context.signal }
      )
      if (boundary === undefined) throw new Error("Space Memory boundary was not resolved")
      const href = boundary.pagePath.split("/").map(encodeURIComponent).join("/")
      return `Memory writes belong to [Space Memory](arden:memory/${href}) and its owned namespace only. A README owns its directory; a leaf page owns itself and the matching directory. Other Memory can be read when the tool permits it.`
    })
    .catch((cause: unknown) => {
      if (cause instanceof ToolExecutionError || cause instanceof Error) {
        return `Memory write boundary unavailable: ${cause.message} Repair the attached Memory in this Space; do not write elsewhere to bypass it.`
      }
      return "Memory write boundary could not be inspected. Do not assume write access."
    })
  return renderPromptSection(
    "Effective prerequisites",
    PROMPT_CATALOG.effectiveAccess.render({ folders, memory, permissions }).text
  )
}
