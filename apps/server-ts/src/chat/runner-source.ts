import type { ModelProvider } from "@arden-hq/loop"
import { Stream } from "effect"
import type { ModelProviderService, ModelRoute } from "../models/provider.js"
import type { ChatRunner } from "./runner-contract.js"

export type ChatRunnerOptions =
  | { readonly runner: ChatRunner | undefined }
  | { readonly runnerFor: (route: ModelRoute) => ChatRunner }

export interface ChatRunnerSource {
  readonly current: () => ChatRunner | undefined
  readonly availability: Stream.Stream<boolean>
}

export const chatRunnerSource = (
  options: ChatRunnerOptions,
  models: ModelProviderService["Service"]
): ChatRunnerSource => {
  if ("runner" in options) {
    const runner = options.runner
    return { current: () => runner, availability: Stream.succeed(runner !== undefined) }
  }
  let made: { readonly provider: ModelProvider; readonly runner: ChatRunner } | undefined
  return {
    current: () => {
      const route = models.current()
      if (route === undefined) return undefined
      if (made?.provider !== route.provider) {
        made = { provider: route.provider, runner: options.runnerFor(route) }
      }
      return made.runner
    },
    availability: models.changes.pipe(Stream.map((route) => route !== undefined))
  }
}
