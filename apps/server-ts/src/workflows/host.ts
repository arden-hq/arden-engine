import { Context } from "effect"
import type { ServerToolRun } from "../chat/runner-contract.js"
import type { ScriptHost } from "./runtime/contract.js"

export class WorkflowHost extends Context.Service<
  WorkflowHost,
  {
    readonly forRun: (run: ServerToolRun) => ScriptHost
  }
>()("@arden-hq/server/workflows/WorkflowHost") {}
