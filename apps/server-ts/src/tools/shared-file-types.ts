import type { ToolContext } from "@arden-hq/loop"
import type { ConversationArtifacts } from "../artifacts/conversation.js"
import type { ManagedOutputWriter } from "../artifacts/managed-output/managed-output.js"
import type { TranscriptQueries } from "../persistence/transcript/queries.js"
import type { LocalPathServices } from "../storage/local-paths.js"
import type { ServerRunContext } from "./run-context.js"

export interface SharedFileServices extends LocalPathServices {
  readonly artifacts: ConversationArtifacts["Service"]
  readonly outputs: ManagedOutputWriter
  readonly transcript: TranscriptQueries["Service"]
  readonly stateRoots: ReadonlyArray<string>
}
export type SharedFileContext = Pick<
  ToolContext<ServerRunContext>,
  "run" | "signal" | "toolCallId" | "approval"
>
export interface ResolvedFile {
  readonly filename: string
  readonly mimeType: string
  readonly bytes: Buffer
}
