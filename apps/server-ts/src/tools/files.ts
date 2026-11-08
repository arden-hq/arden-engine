import { Effect } from "effect"

import { PermissionRules } from "../persistence/permissions/rules.js"
import { DataRoot } from "../runtime/data-root.js"
import { ConversationArtifacts } from "../artifacts/conversation.js"
import {
  ManagedOutputs,
  type ManagedOutputWriter
} from "../artifacts/managed-output/managed-output.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import type { LocalPathServices } from "../storage/local-paths.js"
import type { ServerTool } from "./define.js"
import { fileReadTools } from "./files-read.js"
import { fileWriteTools } from "./files-write.js"

const makeFileTools = ({
  outputs,
  ...services
}: LocalPathServices & {
  readonly outputs: ManagedOutputWriter
}): ReadonlyArray<ServerTool> => [
  ...fileReadTools({ outputs, ...services }),
  ...fileWriteTools(services)
]

export const fileTools = Effect.gen(function* () {
  return makeFileTools({
    sessions: yield* SessionQueries,
    spaces: yield* SpaceStore,
    runs: yield* RunQueries,
    artifacts: yield* ConversationArtifacts,
    outputs: yield* ManagedOutputs,
    rules: yield* PermissionRules,
    dataDir: (yield* DataRoot).dir
  })
})
