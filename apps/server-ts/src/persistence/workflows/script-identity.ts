import { sha256Hex } from "@arden-hq/std/hash"

import type { Schema } from "effect"

export const scriptAgentKey = (logicalKey: string, specificationHash: string): string =>
  sha256Hex(`${logicalKey}\0${specificationHash}`).slice(0, 20)

export const scriptResultText = (result: {
  readonly value: Schema.Json
  readonly error: { readonly message: string } | null
}): string => {
  if (result.error !== null) return result.error.message
  return typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2)
}
