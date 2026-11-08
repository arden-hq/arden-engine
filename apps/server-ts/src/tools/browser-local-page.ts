import { ToolExecutionError } from "@arden-hq/loop"
import { Schema } from "effect"
import { stat } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

import { insideUsableFolder, type LocalPathServices } from "../storage/local-paths.js"
import type { ServerApprovalPrompt } from "./define.js"
import { cwdFor, displayFor, resolveFor } from "./file-tool-support.js"
import type { ServerRunContext } from "./run-context.js"

interface LocalPage {
  readonly url: string
  readonly display: string
  readonly inside: boolean
}

type ToolCtx = {
  readonly run: ServerRunContext
  readonly signal: AbortSignal
  readonly approval?: { readonly data?: unknown } | undefined
}

const isOpenApproval = Schema.is(Schema.Struct({ url: Schema.String }))

const localPageTarget = (url: string): string | undefined => {
  if (/^file:/iu.test(url)) {
    try {
      return fileURLToPath(url)
    } catch {
      throw new ToolExecutionError(`${url} is not a local file URL.`, {
        preview: "Invalid file URL",
        retryable: false
      })
    }
  }
  return url.startsWith("/") || url.startsWith("~") ? url : undefined
}

export const localPages = (paths: LocalPathServices) => {
  const pageOf = async (url: string, ctx: ToolCtx): Promise<LocalPage | undefined> => {
    const target = localPageTarget(url)
    if (target === undefined) return undefined
    const policy = await cwdFor(paths, ctx)
    const resolved = await resolveFor(policy, target)
    if (!(await stat(resolved)).isFile()) {
      throw new ToolExecutionError(`${resolved} is not a file.`, {
        preview: "Not a file",
        retryable: false
      })
    }
    return {
      url: pathToFileURL(resolved).href,
      display: displayFor(policy, resolved),
      inside: insideUsableFolder(policy, resolved)
    }
  }
  return {
    requirement: async (url: string, ctx: ToolCtx): Promise<ServerApprovalPrompt | undefined> => {
      const page = await pageOf(url, ctx)
      return page === undefined || page.inside
        ? undefined
        : { preview: `Open ${page.display} in the browser`, data: { url: page.url } }
    },
    target: async (url: string, ctx: ToolCtx, waived: boolean): Promise<string> => {
      const page = await pageOf(url, ctx)
      if (page === undefined) return url
      const approved = ctx.approval?.data
      if (!page.inside && !waived && !(isOpenApproval(approved) && approved.url === page.url)) {
        throw new ToolExecutionError(
          `${page.display} is no longer the file that was checked, so nothing was opened. Call browser_open again.`,
          { preview: "File changed", retryable: false }
        )
      }
      return page.url
    }
  }
}
