import { unsavedTaskRevision } from "../persistence/work/inference.js"
import { observedKey, type ServerRunContext } from "./run-context.js"

export const taskHandle = (
  run: Pick<ServerRunContext, "observations">,
  task: {
    readonly item_id: string
    readonly stable_key: string
    readonly updated_at: string
    readonly history_revision: string | null
  }
): string => {
  run.observations.observe(
    observedKey.task(task.item_id),
    task.history_revision ?? unsavedTaskRevision(task.item_id)
  )
  return `key ${task.stable_key} · updated_at ${task.updated_at}`
}
