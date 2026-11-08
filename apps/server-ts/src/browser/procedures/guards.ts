import { ToolExecutionError } from "@arden-hq/loop"
import { Effect } from "effect"
import type { BrowserProcedureStore } from "../../persistence/browser-procedures/store.js"
import { refusalOf, typingRule } from "../../tools/browser-task-rules.js"
import type { BrowserObservationRegistry } from "../../tools/run-context.js"
import type { CodeModeCallRequest } from "../../workflows/runtime/contract.js"

const refusal = (message: string): never => {
  throw new ToolExecutionError(message, {
    preview: "Saved browser steps stopped",
    retryable: false
  })
}

export const validateProcedureCall = async (
  store: BrowserProcedureStore["Service"],
  runId: string,
  request: CodeModeCallRequest,
  observations?: BrowserObservationRegistry
): Promise<void> => {
  const scope = await Effect.runPromise(store.scope(runId, request.toolCallId))
  if (scope === undefined) return
  if (scope.rejected) refusal("The user declined a step. This saved procedure has stopped.")
  if (scope.replay) return
  const { name, args } = request
  if (name === "browser_procedure_verify") return
  if (scope.calls >= scope.policy.maxSteps)
    refusal(
      "The saved procedure reached this task's browser-call limit. Inspect the current page before continuing."
    )
  const rejected = refusalOf(
    args,
    {
      tabRef: scope.tab,
      origin: scope.origin,
      rule: typingRule(scope.policy.goal, scope.policy.values),
      secrets: scope.policy.secrets
    },
    (node) => observations?.describe(scope.tab, node)
  )
  if (rejected !== undefined) refusal(rejected)
  const allowed = scope.readOnly
    ? ["browser_snapshot", "browser_wait"]
    : ["browser_snapshot", "browser_wait", "browser_act", "browser_open"]
  if (!allowed.includes(name)) refusal("A saved browser procedure can only use its browser tab.")
  if (args["tab_ref"] !== scope.tab) refusal("The saved procedure tried to use another tab.")
  if (
    name === "browser_act" &&
    (args["origin"] !== scope.origin || args["profile_ref"] !== scope.profile)
  )
    refusal("The saved procedure's site or browser profile changed.")
  if (name === "browser_open") {
    const url = args["url"]
    if (
      typeof url !== "string" ||
      !URL.canParse(url) ||
      new URL(url).origin !== scope.origin ||
      args["disposition"] !== "current"
    )
      refusal("The saved procedure tried to leave its site.")
  }
}
