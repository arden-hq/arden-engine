import { isAbortError } from "../abort.js"
import { ModelProviderError } from "../errors.js"
import type { ModelProvider, ModelProviderRequest, ModelStreamItem } from "../contracts/provider.js"
import { errorMessage } from "@arden-hq/std/errors"

interface ProviderStreamInput {
  readonly provider: ModelProvider
  readonly request: ModelProviderRequest
}

export const openProviderStream = async (
  input: ProviderStreamInput
): Promise<AsyncIterator<ModelStreamItem>> => {
  let source: Iterable<ModelStreamItem> | AsyncIterable<ModelStreamItem>
  try {
    source = await input.provider.stream(input.request)
  } catch (cause) {
    if (isAbortError(cause)) throw cause
    throw new ModelProviderError(`model provider failed: ${errorMessage(cause)}`, cause)
  }
  if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]()
  return (async function* () {
    yield* source
  })()
}
