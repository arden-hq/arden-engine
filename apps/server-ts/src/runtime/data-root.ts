import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import type { DataLocation } from "../config/service.js"

export interface DataRootShape {
  readonly dir: string
  readonly databaseFile: string
  readonly databaseName: string | null
  readonly wiki: { readonly workingRoot: string; readonly historyRoot: string }
  readonly skills: string
  readonly globalInstructions: string
  readonly conversations: string
  readonly uploads: string
  readonly research: string
  readonly managedOutputs: string
  readonly computerPause: string
  readonly computer: string
}

export class DataRoot extends Context.Service<DataRoot, DataRootShape>()(
  "@arden-hq/server/runtime/DataRoot"
) {}

const paths = (
  dir: string,
  database: { readonly file: string; readonly name: string | null },
  managedOutputs: string
): DataRootShape => ({
  dir,
  databaseFile: database.file,
  databaseName: database.name,
  wiki: {
    workingRoot: join(dir, "memory", "wiki", "pages"),
    historyRoot: join(dir, "memory", "wiki", ".wiki-history")
  },
  skills: join(dir, "skills"),
  globalInstructions: join(dir, "AGENTS.md"),
  conversations: join(dir, "conversations"),
  uploads: join(dir, "uploads"),
  research: join(dir, "research"),
  managedOutputs,
  computerPause: join(dir, "computer-control.paused"),
  computer: join(dir, "computer")
})

export const dataRootLayer = (location: DataLocation): Layer.Layer<DataRoot> => {
  switch (location.kind) {
    case "disk": {
      const dir = dirname(location.databasePath)
      return Layer.succeed(
        DataRoot,
        paths(
          dir,
          { file: location.databasePath, name: basename(location.databasePath) },
          join(dir, "managed-outputs")
        )
      )
    }
    case "ephemeral":
      return Layer.effect(
        DataRoot,
        Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "arden-ephemeral-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
        ).pipe(
          Effect.map((dir) =>
            paths(dir, { file: ":memory:", name: null }, location.managedOutputRoot)
          )
        )
      )
  }
}
