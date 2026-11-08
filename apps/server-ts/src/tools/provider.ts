import type { ServerToolRun } from "../chat/runner-contract.js"
import type { ServerTool } from "./define.js"

export interface ToolProvider {
  readonly catalog: () => ReadonlyArray<ServerTool>
  readonly forRun: (run: ServerToolRun) => ReadonlyArray<ServerTool>
  readonly revision?: () => string
}
