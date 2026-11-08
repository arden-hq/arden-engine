import type { ToolCallRequest, ToolResult, Toolset } from "@arden-hq/loop"

interface Built {
  readonly revision: string
  readonly toolset: Toolset
}

export const liveToolset = (options: {
  readonly revision: () => string
  readonly build: () => Toolset
  readonly initial: Built
  readonly onBuildFailure?: (cause: unknown) => void
}): Toolset => {
  let built = options.initial
  let rebuilding: Promise<Toolset> | undefined
  let failedRevision: string | undefined
  const rebuild = async (revision: string): Promise<Toolset> => {
    let toolset: Toolset
    try {
      toolset = options.build()
    } catch (cause) {
      failedRevision = revision
      options.onBuildFailure?.(cause)
      return built.toolset
    }
    const loaded = await built.toolset.loadedNames()
    if (loaded.size > 0) {
      await (toolset.seedLoadedNames === undefined
        ? toolset.load(loaded)
        : toolset.seedLoadedNames(loaded))
    }
    built = { revision, toolset }
    return toolset
  }
  const current = (): Toolset | Promise<Toolset> => {
    if (rebuilding !== undefined) return rebuilding
    const revision = options.revision()
    if (revision === built.revision || revision === failedRevision) return built.toolset
    rebuilding = rebuild(revision).finally(() => {
      rebuilding = undefined
    })
    return rebuilding
  }
  const { displayTitle } = built.toolset
  return {
    ...(displayTitle === undefined ? {} : { displayTitle }),
    entries: async () => (await current()).entries(),
    metadata: async (name) => (await current()).metadata?.(name),
    loadedNames: async () => (await current()).loadedNames(),
    load: async (names) => (await current()).load(names),
    seedLoadedNames: async (names) => {
      const toolset = await current()
      await (toolset.seedLoadedNames === undefined
        ? toolset.load(names)
        : toolset.seedLoadedNames(names))
    },
    execute: async (request: ToolCallRequest) => (await current()).execute(request),
    decorateResult: (request: ToolCallRequest, result: ToolResult) =>
      built.toolset.decorateResult?.(request, result) ?? result
  }
}
