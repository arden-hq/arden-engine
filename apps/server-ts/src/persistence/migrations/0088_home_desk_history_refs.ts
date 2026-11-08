import type { Migration } from "./index.js"

export const homeDeskHistoryRefs: Migration = {
  version: 88,
  name: "home_desk_history_refs",
  foreignKeys: { kind: "enforced" },
  up: () => {}
}
