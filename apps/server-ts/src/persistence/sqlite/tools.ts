import { ToolHistoryQueries } from "../tools/history-queries.js"
import { ToolExecutionStore } from "../tools/store.js"
import type { PersistenceDeps } from "./deps.js"
import { makeToolApprovalResolve } from "./tool-approval-resolve.js"
import { makeToolExecutions } from "./tool-executions.js"
import { makeToolHistory } from "./tool-history.js"
import { makeToolCoordinatorSuspend } from "./tool-coordinator.js"

export const makeToolStores = (
  deps: Pick<PersistenceDeps, "reader" | "writer" | "chatEvents" | "sessionEvents"> & {
    readonly dataDir: string | null
  }
): {
  readonly executions: ToolExecutionStore["Service"]
  readonly history: ToolHistoryQueries["Service"]
} => {
  const { history, priorResults, pendingConnection, allPendingConnections } = makeToolHistory(deps)
  const executions = ToolExecutionStore.of({
    ...makeToolExecutions(deps),
    suspend: makeToolCoordinatorSuspend(deps),
    resolve: makeToolApprovalResolve(deps),
    priorResults,
    pendingConnection,
    allPendingConnections
  })
  return { executions, history }
}
