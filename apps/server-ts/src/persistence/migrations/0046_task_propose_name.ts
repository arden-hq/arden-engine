import type { Migration } from "./index.js"

export const taskProposeName: Migration = {
  version: 46,
  name: "task_propose_name",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    const row = database
      .prepare("SELECT overrides_json FROM tool_settings WHERE singleton_id = 1")
      .get()
    const stored = row?.["overrides_json"]
    if (typeof stored !== "string") return
    const overrides: unknown = JSON.parse(stored)
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return
    const next: Record<string, unknown> = { ...overrides }
    if ("desk_task_infer" in next) {
      if (!("task_propose" in next)) next["task_propose"] = next["desk_task_infer"]
      delete next["desk_task_infer"]
    }
    delete next["task_undo"]
    database
      .prepare("UPDATE tool_settings SET overrides_json = ? WHERE singleton_id = 1")
      .run(JSON.stringify(next))
  }
}
