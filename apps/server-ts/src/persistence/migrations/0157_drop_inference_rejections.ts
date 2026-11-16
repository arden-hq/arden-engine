import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** `task_inference_rejections` had no writer; its rows (one per undone inferred Task) repeat what
 * `space_tasks` holds as a cancelled inferred Task, which the Space review now lists as stopped.
 * A No on an offer lives in `task_proposals.status` alone. */
const up = (database: DatabaseSync): void => {
  database.exec("DROP TABLE task_inference_rejections")
}

export const dropInferenceRejections: Migration = {
  version: 157,
  name: "drop_inference_rejections",
  foreignKeys: { kind: "enforced" },
  up
}
