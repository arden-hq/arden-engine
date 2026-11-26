import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec("DROP TABLE task_inference_rejections")
}

export const dropInferenceRejections: Migration = {
  version: 157,
  name: "drop_inference_rejections",
  foreignKeys: { kind: "enforced" },
  up
}
