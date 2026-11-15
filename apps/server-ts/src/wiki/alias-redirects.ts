import { Effect } from "effect"

import type { ContentStepRedirect, ContentStepRewrite, WikiContentStep } from "./content-steps.js"
import { nameKeys, normal, pageAliases, takesName } from "./page.js"

const redirectPaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const chosen: Array<string> = []
  const covered = new Set<string>()
  const choose = (path: string) => {
    if (covered.has(normal(path))) return
    chosen.push(path)
    for (const key of nameKeys(path)) covered.add(key)
  }
  for (const path of paths) if (path.endsWith(".md")) choose(path)
  for (const path of paths) if (!covered.has(normal(path))) choose(`${path}.md`)
  return chosen
}

const pathAliasesToRedirects = (
  pages: ReadonlyArray<{
    readonly path: string
    readonly title: string
    readonly aliases: ReadonlyArray<string>
    readonly body: string
  }>,
  taken: ReadonlySet<string>
): ContentStepRewrite => {
  const occupied = new Set(taken)
  const redirects: Array<ContentStepRedirect> = []
  const rewritten = pages.map((page, index) => {
    const aliases = pageAliases(page.title, page.aliases)
    for (const path of redirectPaths(aliases.paths)) {
      if (takesName(occupied, path)) continue
      for (const key of nameKeys(path)) occupied.add(key)
      redirects.push({ path, to: index })
    }
    return { ...page, aliases: aliases.names }
  })
  return { pages: rewritten, redirects }
}

export const pathAliasRedirects: WikiContentStep<never> = {
  name: "0002_path_aliases_to_redirects",
  reason: "Keep old paths as redirects, not as names",
  rewrite: (pages, taken) => Effect.succeed(pathAliasesToRedirects(pages, taken))
}
