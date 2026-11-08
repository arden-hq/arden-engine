import { Context, Effect, Layer } from "effect"

import { makeTerminalStore, type TerminalStore } from "./store.js"

export class TerminalSessions extends Context.Service<TerminalSessions, TerminalStore>()(
  "@arden-hq/server/terminals/TerminalSessions"
) {
  static readonly layer = Layer.effect(
    TerminalSessions,
    Effect.acquireRelease(
      Effect.sync(() => makeTerminalStore()),
      (store) => Effect.sync(() => store.dispose())
    )
  )
}
