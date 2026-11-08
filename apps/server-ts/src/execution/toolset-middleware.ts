import type { ToolCallMiddleware, ToolCallRequest, ToolResult, Toolset } from "@arden-hq/loop"

export interface ToolsetMiddleware {
  readonly execute?: ToolCallMiddleware
  readonly decorateResult?: (request: ToolCallRequest, result: ToolResult) => ToolResult
}

const wrap = (inner: Toolset, middleware: ToolsetMiddleware): Toolset => {
  const { execute, decorateResult } = middleware
  return {
    ...inner,
    ...(execute === undefined
      ? {}
      : { execute: (request: ToolCallRequest) => execute(request, inner.execute) }),
    ...(decorateResult === undefined
      ? {}
      : {
          decorateResult: (request: ToolCallRequest, result: ToolResult) =>
            decorateResult(request, inner.decorateResult?.(request, result) ?? result)
        })
  }
}

export const withMiddleware = (
  toolset: Toolset,
  middlewares: ReadonlyArray<ToolsetMiddleware>
): Toolset => middlewares.reduceRight(wrap, toolset)

export const mergeToolsets = (
  base: Toolset,
  addition: { readonly toolset: Toolset; readonly names: ReadonlySet<string> }
): Toolset => {
  const extra = addition.toolset
  const owns = (request: ToolCallRequest): boolean => addition.names.has(request.name)
  const displayTitle = base.displayTitle ?? extra.displayTitle
  return {
    ...(displayTitle === undefined ? {} : { displayTitle }),
    entries: async () => [...(await base.entries()), ...(await extra.entries())],
    metadata: async (name) => (await extra.metadata?.(name)) ?? (await base.metadata?.(name)),
    loadedNames: async () =>
      new Set([...(await base.loadedNames()), ...(await extra.loadedNames())]),
    load: async (names) => {
      await base.load(names)
      await extra.load(names)
    },
    seedLoadedNames: async (names) => {
      await base.seedLoadedNames?.(names)
      await extra.seedLoadedNames?.(names)
    },
    execute: (request) => (owns(request) ? extra.execute(request) : base.execute(request)),
    decorateResult: (request, result): ToolResult =>
      owns(request) || base.decorateResult === undefined
        ? result
        : base.decorateResult(request, result)
  }
}
